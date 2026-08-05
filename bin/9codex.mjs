#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalog, writeCatalog } from "../lib/catalog.mjs";
import {
  injectCodexConfig,
  restoreCodexConfig,
} from "../lib/codex-config.mjs";
import {
  defaultConfig,
  loadConfig,
  migrateLegacyConfig,
  redactConfig,
  saveConfigAtomic,
} from "../lib/config.mjs";
import { runDaemon } from "../lib/daemon.mjs";
import { runInitFlow } from "../lib/init-flow.mjs";
import {
  enableAllModels,
  refreshUpstreamModels,
  selectEnabledModels,
} from "../lib/models.mjs";
import { runMcpServer } from "../lib/mcp.mjs";
import { restartCodex } from "../lib/platform.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import { installService, restartService, uninstallService } from "../lib/service.mjs";
import { resolveLatestVersion, runStagedUpdate } from "../lib/updater.mjs";
import {
  askApiKey,
  askBaseUrl,
  askModelSelection,
  createInterface,
  isInteractive,
} from "../lib/wizard.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const home = process.env.NINECODEX_HOME || os.homedir();
const paths = resolvePaths(home);
const cliPath = fileURLToPath(import.meta.url);

function ensureConfig() {
  if (fs.existsSync(paths.config)) return loadConfig(paths);
  if (fs.existsSync(paths.legacyConfig)) return migrateLegacyConfig(paths, { deviceName: os.hostname() });
  const config = defaultConfig({ deviceName: os.hostname() });
  saveConfigAtomic(paths, config);
  return config;
}

async function refreshCatalog(config, { strict = false } = {}) {
  const upstreamChanged = config.models.source_base_url !== config.upstream.base_url;
  try {
    config.models.available = await refreshUpstreamModels(config);
    config.models.source_base_url = config.upstream.base_url;
    if (upstreamChanged) config.models.enabled_ids = null;
    const availableIds = new Set(
      config.models.available.filter((row) => row.enabled !== false).map((row) => row.id),
    );
    if (Array.isArray(config.models.enabled_ids)) {
      const retained = config.models.enabled_ids.filter((id) => availableIds.has(id));
      config.models.enabled_ids = retained.length > 0 ? retained : null;
    }
    const enabledIds = config.models.enabled_ids || [...availableIds];
    if (enabledIds.length > 0 && !enabledIds.includes(config.upstream.default_model)) {
      config.upstream.default_model = enabledIds[0];
    }
    saveConfigAtomic(paths, config);
  } catch (error) {
    if (strict) throw error;
    if (config.models.source_base_url !== config.upstream.base_url) {
      config.models.available = [];
      config.models.source_base_url = config.upstream.base_url;
      saveConfigAtomic(paths, config);
    }
    console.error(`9codex model refresh warning: ${error.message}`);
  }
  writeCatalog(paths, buildCatalog(config));
  return config;
}

function isConfigured(config) {
  return Boolean(config.upstream.base_url && config.upstream.api_key);
}

async function runLocalInit(config) {
  if (!isInteractive()) {
    throw new Error("请在交互终端运行 `9codex init` 配置中转地址和 API Key");
  }
  const rl = createInterface();
  try {
    const hadUpstream = isConfigured(config);
    const baseUrl = await askBaseUrl(rl, hadUpstream ? config.upstream.base_url : "");
    const apiKey = await askApiKey(rl, hadUpstream ? config.upstream.api_key : "");
    config = structuredClone(config);
    config.upstream.base_url = baseUrl;
    config.upstream.api_key = apiKey;
    if (baseUrl !== config.models.source_base_url) {
      config.models.available = [];
      config.models.enabled_ids = null;
      config.models.source_base_url = null;
    }
    config = await refreshCatalog(config, { strict: true });
    if (config.models.available.length === 0) {
      throw new Error("中转未返回可用模型");
    }
    const enabledIds = await askModelSelection(rl, config.models.available);
    config = enabledIds ? selectEnabledModels(config, enabledIds) : enableAllModels(config);
    saveConfigAtomic(paths, config);
    writeCatalog(paths, buildCatalog(config));
    return config;
  } finally {
    rl.close();
  }
}

async function syncModels(config) {
  if (!isConfigured(config)) {
    throw new Error("尚未配置中转。请先在交互终端运行 `9codex init`");
  }
  config = await refreshCatalog(config, { strict: true });
  if (isInteractive() && config.models.available.length > 0) {
    const rl = createInterface();
    try {
      const enabledIds = await askModelSelection(rl, config.models.available, {
        enabledIds: config.models.enabled_ids,
        emptySelection: null,
        emptyLabel: "保留当前选择",
      });
      if (enabledIds !== null) config = selectEnabledModels(config, enabledIds);
      saveConfigAtomic(paths, config);
      writeCatalog(paths, buildCatalog(config));
    } finally {
      rl.close();
    }
  }
  injectCodexConfig(paths, config, { nodePath: process.execPath, cliPath });
  const selected = Array.isArray(config.models.enabled_ids)
    ? new Set(config.models.enabled_ids)
    : null;
  return {
    mode: selected ? "selected" : "all",
    models: config.models.available
      .filter((row) => row.enabled !== false)
      .map((row) => ({ id: row.id, enabled: !selected || selected.has(row.id) })),
  };
}

async function health(config, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://${config.local.host}:${config.local.port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(config, timeoutMs = 20_000, expectedVersion = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await health(config, 1000);
    if (
      result?.ok
      && result?.service === "9codex"
      && (!expectedVersion || result.version === expectedVersion)
    ) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function runInstalledCli(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`9codex ${command} exited with ${status}`));
    });
  });
}

async function withDesktopMaintenance(operation) {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.desktopMaintenance, `${JSON.stringify({
    pid: process.pid,
    expires_at: Date.now() + 120_000,
  })}\n`, { mode: 0o600 });
  try {
    return await operation();
  } finally {
    try {
      fs.unlinkSync(paths.desktopMaintenance);
    } catch {}
  }
}

async function configureCodex(config) {
  injectCodexConfig(paths, config, { nodePath: process.execPath, cliPath });
}

async function restartCodexWithRepair(config) {
  return restartCodex({
    sessionFile: paths.desktopSession,
    beforeOpen: () => configureCodex(config),
  });
}

async function install(config, { refresh = true } = {}) {
  if (!isConfigured(config)) {
    throw new Error("尚未配置中转。请先运行 `9codex init`");
  }
  if (refresh) await refreshCatalog(config);
  await installService(paths, { cliPath, nodePath: process.execPath });
  return withDesktopMaintenance(async () => {
    await restartService(paths);
    const ready = await waitForHealth(config, 20_000, packageInfo.version);
    if (!ready) throw new Error("9codex service did not become healthy");
    let codex;
    try {
      codex = await restartCodexWithRepair(config);
    } catch (error) {
      await configureCodex(config);
      codex = { codex_restarted: false, error: error.message };
    }
    return { health: ready, codex };
  });
}

const [command = "status", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "init": {
      let config = ensureConfig();
      const controlPlaneUrl = args[0] || process.env.NINECODEX_API_URL || config.control_plane.base_url;
      if (controlPlaneUrl) {
        config = await runInitFlow(paths, controlPlaneUrl, { version: packageInfo.version });
      } else {
        config = await runLocalInit(config);
      }
      const result = await install(config, { refresh: false });
      console.log(JSON.stringify({ initialized: true, authorized: Boolean(controlPlaneUrl), ...result }, null, 2));
      break;
    }
    case "install": {
      const result = await install(ensureConfig());
      console.log(JSON.stringify({ installed: true, ...result }, null, 2));
      break;
    }
    case "sync": {
      console.log(JSON.stringify(await syncModels(ensureConfig()), null, 2));
      break;
    }
    case "status": {
      const config = ensureConfig();
      const result = await health(config);
      console.log(JSON.stringify({
        version: packageInfo.version,
        configured: true,
        authorized: Boolean(config.control_plane.authorization_id),
        health: result,
        config: redactConfig(config),
      }, null, 2));
      process.exitCode = result?.ok ? 0 : 1;
      break;
    }
    case "restart":
      await restartService(paths);
      if (!(await waitForHealth(loadConfig(paths)))) throw new Error("9codex service restart failed");
      console.log("9codex service restarted.");
      break;
    case "codex-restart": {
      const cfg = loadConfig(paths);
      const current = await health(cfg);
      if (!current?.ok || current.version !== packageInfo.version) {
        const result = await install(cfg, { refresh: false });
        console.log(JSON.stringify({ ...result.codex, service_self_healed: true }, null, 2));
        break;
      }
      console.log(JSON.stringify(
        await withDesktopMaintenance(() => restartCodexWithRepair(cfg)),
        null,
        2,
      ));
      break;
    }
    case "auth-token":
      process.stdout.write(`${loadConfig(paths).local.token}\n`);
      break;
    case "models": {
      let config = await refreshCatalog(ensureConfig());
      const [action = "list", ...modelIds] = args;
      if (action === "select") {
        config = selectEnabledModels(config, modelIds);
        saveConfigAtomic(paths, config);
        writeCatalog(paths, buildCatalog(config));
        injectCodexConfig(paths, config, { nodePath: process.execPath, cliPath });
      } else if (action === "all") {
        config = enableAllModels(config);
        saveConfigAtomic(paths, config);
        writeCatalog(paths, buildCatalog(config));
        injectCodexConfig(paths, config, { nodePath: process.execPath, cliPath });
      } else if (action !== "list") {
        throw new Error("Commands: models list, models select <model...>, models all");
      }
      const selected = Array.isArray(config.models.enabled_ids)
        ? new Set(config.models.enabled_ids)
        : null;
      console.log(JSON.stringify({
        mode: selected ? "selected" : "all",
        models: config.models.available
          .filter((row) => row.enabled !== false)
          .map((row) => ({ id: row.id, enabled: !selected || selected.has(row.id) })),
      }, null, 2));
      break;
    }
    case "update": {
      const config = loadConfig(paths);
      const target = args[0] || await resolveLatestVersion(config.updates);
      const result = await runStagedUpdate({
        package: "@hooliy/9codex",
        version: target,
        channel: config.updates.channel,
        registry: config.updates.npm_registry,
      }, {
        currentVersion: packageInfo.version,
        policy: config.updates,
        activate: () => runInstalledCli("install"),
        health: async () => Boolean(await waitForHealth(loadConfig(paths))),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "version":
      console.log(packageInfo.version);
      break;
    case "uninstall":
      await uninstallService(paths);
      restoreCodexConfig(paths);
      console.log("9codex service removed and the prior Codex configuration restored. Local 9codex configuration was retained.");
      break;
    case "daemon":
      await runDaemon(paths, {
        version: packageInfo.version,
        nodePath: process.execPath,
        cliPath,
        restartCodex: () => withDesktopMaintenance(() => restartCodexWithRepair(loadConfig(paths))),
        onError: (error) => console.error(`9codex daemon: ${error.message}`),
        updatePackage: async (request) => {
          const active = loadConfig(paths);
          return runStagedUpdate(request, {
            currentVersion: packageInfo.version,
            policy: active.updates,
            activate: () => runInstalledCli("install"),
            health: async () => Boolean(await waitForHealth(loadConfig(paths))),
          });
        },
      });
      break;
    case "mcp":
      await runMcpServer(loadConfig(paths), {
        version: packageInfo.version,
        outputDir: paths.imagesDir,
      });
      break;
    default:
      throw new Error("Commands: init, sync, install, status, models, restart, codex-restart, auth-token, update, version, uninstall");
  }
} catch (error) {
  console.error(`9codex error: ${error.message}`);
  process.exitCode = 1;
}
