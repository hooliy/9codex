import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dispatchRemoteCommand,
  parseSseCommands,
  runDaemon,
  startGatewayServer,
  terminateStaleDaemon,
} from "../lib/daemon.mjs";
import { defaultConfig, saveConfigAtomic } from "../lib/config.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const now = new Date("2026-08-01T08:05:00Z");

function remoteCommand(type, sequence = 1, payload = {}) {
  return {
    command_id: `cmd_${sequence}`,
    sequence,
    type,
    issued_at: "2026-08-01T08:00:00Z",
    expires_at: "2026-08-01T08:10:00Z",
    payload,
  };
}

test("parses command events from fragmented SSE input", () => {
  const chunks = [
    "event: command\nid: cmd_1\ndata: {\"command_id\":\"cmd_1\",\"sequence\":1,",
    "\"type\":\"codex.restart\",\"issued_at\":\"2026-08-01T08:00:00Z\",",
    "\"expires_at\":\"2026-08-01T08:10:00Z\",\"payload\":{}}\n\n",
  ];

  assert.deepEqual(parseSseCommands(chunks), [remoteCommand("codex.restart")]);
});

test("acknowledges lifecycle and automatically restarts Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const statuses = [];
  let codexRestarted = 0;
  const config = {
    installation: { installation_id: "ins_test" },
    codex: { restart_policy: "automatic" },
  };

  const result = await dispatchRemoteCommand(remoteCommand("codex.restart"), {
    paths,
    config,
    now: () => now,
    ack: async (payload) => { statuses.push(payload.status); },
    restartCodex: async () => { codexRestarted += 1; return { codex_restarted: true }; },
  });

  assert.deepEqual(statuses, ["received", "running", "succeeded"]);
  assert.equal(codexRestarted, 1);
  assert.equal(result.codex_restarted, true);
});

test("refreshes transactional configuration, acknowledges, then restarts local service", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const order = [];
  const config = {
    installation: { installation_id: "ins_test" },
    codex: { restart_policy: "automatic" },
  };
  await dispatchRemoteCommand(remoteCommand("config.refresh"), {
    paths,
    config,
    now: () => now,
    ack: async (payload) => { order.push(`ack:${payload.status}`); },
    syncConfig: async () => { order.push("sync"); return { changed: true, config: { ...config, models: {} } }; },
    injectCodex: async () => { order.push("inject"); },
    restartService: async () => { order.push("restart-service"); },
  });

  assert.deepEqual(order, [
    "ack:received",
    "ack:running",
    "sync",
    "inject",
    "ack:succeeded",
    "restart-service",
  ]);
});

test("daemon rejects invalid model state before creating a gateway", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  saveConfigAtomic(paths, config);
  let created = false;

  await assert.rejects(
    () => runDaemon(paths, {
      createGateway: () => { created = true; },
    }),
    /model metadata|catalog|model state/i,
  );
  assert.equal(created, false);
});

test("terminates a stale 9codex daemon recorded in the pid file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.daemonPid, "7654\n", { mode: 0o600 });

  const calls = [];
  const killed = await terminateStaleDaemon(paths, {
    platform: "win32",
    run: async (file, args) => { calls.push([file, args]); return 0; },
  });

  assert.equal(killed, true);
  assert.deepEqual(calls, [["taskkill.exe", ["/PID", "7654", "/F", "/T"]]]);
  assert.equal(fs.existsSync(paths.daemonPid), false);
});

test("does not terminate when the pid file is missing or stale", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);

  assert.equal(await terminateStaleDaemon(paths, {
    platform: "darwin",
    run: async () => 1,
  }), false);

  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.daemonPid, "999999\n");
  const calls = [];
  assert.equal(await terminateStaleDaemon(paths, {
    platform: "darwin",
    run: async (file, args) => { calls.push([file, args]); return 1; },
  }), false);
  assert.deepEqual(calls, [["/bin/kill", ["-9", "999999"]]]);
});

test("takes over the gateway port when a stale daemon still owns it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.daemonPid, "4321\n", { mode: 0o600 });
  const fakeServer = {
    listens: 0,
    once() {},
    listen(port, host, cb) {
      this.listens += 1;
      if (this.listens === 1) cb(new Error("listen EADDRINUSE: address already in use 127.0.0.1:10101"));
      else cb();
    },
  };
  const options = {
    platform: "win32",
    createGateway: () => fakeServer,
    run: async () => 0,
  };
  const server = await startGatewayServer(paths, { local: { host: "127.0.0.1", port: 10101 } }, options);
  assert.equal(server, fakeServer);
  assert.equal(server.listens, 2);
  assert.equal(fs.existsSync(paths.daemonPid), false);
});

test("daemon starts the persistent team runtime before the gateway", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  saveConfigAtomic(paths, config);
  const order = [];
  const team = {
    observeTeamEvent() {},
    async close() { order.push("team-close"); },
  };
  const server = {
    once() {},
    listen(port, host, callback) { order.push("gateway"); callback(); },
    close(callback) { order.push("gateway-close"); callback(); },
  };
  const controller = new AbortController();
  const running = runDaemon(paths, {
    signal: controller.signal,
    validateModelState: () => true,
    startTeamRuntime: async () => { order.push("team"); return team; },
    createGateway: () => server,
    startAutomaticUpdates: () => ({ close() {} }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await running;
  assert.deepEqual(order, ["team", "gateway", "gateway-close", "team-close"]);
});
