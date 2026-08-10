import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { startAutomaticUpdates } from "./auto-update.mjs";
import { executeCommand } from "./commands.mjs";
import { ackCommand, sendHeartbeat, syncBootstrap } from "./control-plane.mjs";
import { loadConfig } from "./config.mjs";
import { injectCodexConfig } from "./codex-config.mjs";
import { createGateway } from "./gateway.mjs";
import { validateModelState } from "./model-state.mjs";
import { restartCodex } from "./platform.mjs";
import { restartService } from "./service.mjs";

export function parseSseCommands(chunks) {
  const text = chunks.join("");
  const commands = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (event !== "command") continue;
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    commands.push(JSON.parse(data));
  }
  return commands;
}

export async function dispatchRemoteCommand(command, context) {
  const startedAt = (context.now?.() || new Date()).toISOString();
  await context.ack({
    installation_id: context.config.installation.installation_id,
    status: "received",
    started_at: startedAt,
  });
  await context.ack({
    installation_id: context.config.installation.installation_id,
    status: "running",
    started_at: startedAt,
  });
  const deferred = [];
  try {
    const result = await executeCommand(command, {
      ...context,
      deferAfterAck: (operation) => deferred.push(operation),
    });
    await context.ack({
      installation_id: context.config.installation.installation_id,
      status: "succeeded",
      started_at: startedAt,
      finished_at: (context.now?.() || new Date()).toISOString(),
      result,
    });
    for (const operation of deferred) await operation();
    return result;
  } catch (error) {
    await context.ack({
      installation_id: context.config.installation.installation_id,
      status: error.code ? "rejected" : "failed",
      started_at: startedAt,
      finished_at: (context.now?.() || new Date()).toISOString(),
      error: { code: error.code || "command_failed", message: error.message },
    });
    throw error;
  }
}

async function consumeEventStream(response, onCommand) {
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      const boundary = match.index;
      const block = buffer.slice(0, boundary + match[0].length);
      buffer = buffer.slice(boundary + match[0].length);
      for (const command of parseSseCommands([block])) await onCommand(command);
    }
  }
}

async function eventLoop(paths, options) {
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (!options.signal?.aborted) {
    const config = loadConfig(paths);
    if (!config.control_plane?.base_url || !config.control_plane?.access_token || !config.control_plane.events_enabled) return;
    try {
      const eventsUrl = new URL(
        config.control_plane.events_url || "/v1/agent/events",
        `${config.control_plane.base_url.replace(/\/$/, "")}/`,
      );
      const response = await (options.fetchImpl || fetch)(eventsUrl, {
        headers: {
          authorization: `Bearer ${config.control_plane.access_token}`,
          "x-9codex-installation-id": config.installation.installation_id,
          accept: "text/event-stream",
        },
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`event stream HTTP ${response.status}`);
      await consumeEventStream(response, async (command) => {
        const active = loadConfig(paths);
        await dispatchRemoteCommand(command, {
          paths,
          config: active,
          ack: (payload) => ackCommand(active, command.command_id, payload, options),
          restartCodex: () => restartCodex({ ...options, sessionFile: paths.desktopSession }),
          syncConfig: () => syncBootstrap(paths, loadConfig(paths), options),
          injectCodex: async (updated) => injectCodexConfig(paths, updated, {
            nodePath: options.nodePath,
            cliPath: options.cliPath,
          }),
          restartService: () => restartService(paths, options),
          updatePackage: options.updatePackage || (async () => {
            throw new Error("Package updater is unavailable in this runtime");
          }),
          collectDiagnostics: () => ({ service: "9codex", pid: process.pid }),
        });
      });
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onError?.(error);
      await wait(5000);
    }
  }
}

function recordedDaemonPid(paths) {
  try {
    const text = fs.readFileSync(paths.daemonPid, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : 0;
  } catch {
    return 0;
  }
}

export async function terminateStaleDaemon(paths, options = {}) {
  const pid = recordedDaemonPid(paths);
  if (!pid) return false;
  const platform = options.platform || process.platform;
  const run = options.run || ((file, args) => new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (status) => resolve(status));
  }));
  let status;
  if (platform === "win32") {
    status = await run("taskkill.exe", ["/PID", String(pid), "/F", "/T"]);
  } else {
    status = await run("/bin/kill", ["-9", String(pid)]);
  }
  try {
    fs.unlinkSync(paths.daemonPid);
  } catch {}
  return status === 0;
}

export async function startGatewayServer(paths, config, options = {}) {
  const create = options.createGateway || createGateway;
  const server = create(config, paths, options);
  const listen = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.local.port, config.local.host, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  try {
    await listen();
    return server;
  } catch (error) {
    if (!String(error?.message || "").includes("EADDRINUSE")) throw error;
    const terminated = await terminateStaleDaemon(paths, options);
    if (!terminated) throw error;
    await listen();
    return server;
  }
}

function redirectDaemonOutput(logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const stream = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
    const write = (chunk) => {
      try { stream.write(chunk); } catch {}
    };
    process.stdout.write = write;
    process.stderr.write = write;
  } catch {}
}

function installCrashHandlers(logFile) {
  const log = (error) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${error?.stack || error}\n`, { mode: 0o600 });
    } catch {}
  };
  process.on("uncaughtException", log);
  process.on("unhandledRejection", log);
}

export async function runDaemon(paths, options = {}) {
  if (process.argv.includes("--redirect-logs")) {
    redirectDaemonOutput(paths.daemonLog);
    installCrashHandlers(paths.daemonLog);
  }
  const config = loadConfig(paths);
  validateModelState(paths, config);
  const server = await startGatewayServer(paths, config, options);
  fs.writeFileSync(paths.daemonPid, `${process.pid}\n`, { mode: 0o600 });
  const controller = new AbortController();
  const signal = options.signal || controller.signal;
  const heartbeatMs = Math.max(
    30,
    Number(config.control_plane?.heartbeat_interval_seconds) || 60,
  ) * 1000;
  const heartbeat = setInterval(() => {
    const active = loadConfig(paths);
    if (!active.control_plane?.base_url || !active.control_plane?.access_token) return;
    void sendHeartbeat(active, {
      installation_id: active.installation.installation_id,
      ninecodex_version: options.version || "3.0.0",
      service_status: "running",
      config_revision: active.control_plane.config_revision,
      catalog_revision: active.models.catalog_revision,
      active_model: active.upstream.default_model,
      platform: process.platform,
    }, options).catch(options.onError || (() => {}));
  }, heartbeatMs);
  heartbeat.unref();
  const automaticUpdates = config.updates?.enabled !== false
    && config.updates?.auto_install !== false
    ? (options.startAutomaticUpdates || startAutomaticUpdates)(paths, {
        ...options,
        currentVersion: options.version,
        nodePath: options.nodePath,
        cliPath: options.cliPath,
      })
    : null;
  void eventLoop(paths, { ...options, signal }).catch(options.onError || (() => {}));

  return new Promise((resolve) => {
    const close = () => {
      controller.abort();
      clearInterval(heartbeat);
      automaticUpdates?.close();
      try {
        if (Number(fs.readFileSync(paths.daemonPid, "utf8").trim()) === process.pid) {
          fs.unlinkSync(paths.daemonPid);
        }
      } catch {}
      server.close(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    if (options.signal) options.signal.addEventListener("abort", close, { once: true });
  });
}
