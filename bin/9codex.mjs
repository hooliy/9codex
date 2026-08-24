#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateInstallation,
  reconcileAndActivateInstallation,
} from "../lib/activation.mjs";
import {
  ownsUpdateLock,
  readPendingUpdate,
  releaseUpdateLock,
  waitForGatewayIdle,
} from "../lib/auto-update.mjs";
import { launchCodexDesktop } from "../lib/codex-launch.mjs";
import {
  defaultConfig,
  loadConfig,
  redactConfig,
} from "../lib/config.mjs";
import { runDaemon } from "../lib/daemon.mjs";
import { runInitFlow } from "../lib/init-flow.mjs";
import {
  enableAllModels,
  selectEnabledModels,
} from "../lib/models.mjs";
import { reconcileModelState, repairLocalModelState } from "../lib/model-state.mjs";
import { runMcpServer } from "../lib/mcp.mjs";
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

function loadCandidateConfig() {
  if (fs.existsSync(paths.config)) return loadConfig(paths);
  return defaultConfig({ deviceName: os.hostname() });
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
    const result = await reconcileModelState(paths, config, {
      candidateConfig: config,
      prepareCandidate: async (candidate) => {
        const enabledIds = await askModelSelection(rl, candidate.models.available);
        return enabledIds
          ? selectEnabledModels(candidate, enabledIds)
          : enableAllModels(candidate);
      },
    });
    return result.config;
  } finally {
    rl.close();
  }
}

async function syncModels(config) {
  if (!isConfigured(config)) {
    throw new Error("尚未配置中转。请先在交互终端运行 `9codex init`");
  }
  const interactive = isInteractive();
  const rl = interactive ? createInterface() : null;
  try {
    const result = await reconcileModelState(paths, config, {
      prepareCandidate: interactive
        ? async (candidate) => {
            const enabledIds = await askModelSelection(rl, candidate.models.available, {
              enabledIds: candidate.models.enabled_ids,
              emptySelection: null,
              emptyLabel: "保留当前选择",
            });
            return enabledIds === null ? candidate : selectEnabledModels(candidate, enabledIds);
          }
        : undefined,
    });
    config = result.config;
  } finally {
    rl?.close();
  }
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
      && result?.ready
      && result?.service === "9codex"
      && Number.isInteger(result.model_count)
      && result.model_count > 0
      && (!expectedVersion || result.version === expectedVersion)
    ) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function runInstalledCli(installation, command, args = []) {
  if (!installation?.cliPath) {
    throw new Error("Updated package did not provide an installed CLI path");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installation.cliPath, command, ...args], {
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

function activationDependencies() {
  return {
    installService: () => installService(paths, { cliPath, nodePath: process.execPath }),
    restartService: () => restartService(paths),
    waitForHealth: (config) => waitForHealth(config, 20_000, packageInfo.version),
  };
}

async function activate(config) {
  return activateInstallation(paths, config, activationDependencies());
}

async function install(config) {
  if (!isConfigured(config)) {
    throw new Error("尚未配置中转。请先运行 `9codex init`");
  }
  return reconcileAndActivateInstallation(paths, config, activationDependencies());
}

async function waitForChild(child, label) {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`${label} exited with ${status}`));
    });
  });
}

async function launchCodex(config, workspace, { bridge = true } = {}) {
  const child = launchCodexDesktop({
    config,
    paths,
    workspace,
    ...(process.env.CODEX_CLI_PATH ? { command: process.env.CODEX_CLI_PATH } : {}),
    platform: process.platform,
    interactiveSessionBridge: bridge,
    nodePath: process.execPath,
    cliPath,
  });
  await waitForChild(child, "codex app");
}

const [command = "status", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "init": {
      let config = loadCandidateConfig();
      const controlPlaneUrl = args[0] || process.env.NINECODEX_API_URL || config.control_plane.base_url;
      if (controlPlaneUrl) {
        config = await runInitFlow(paths, controlPlaneUrl, {
          version: packageInfo.version,
          config,
        });
      } else {
        config = await runLocalInit(config);
      }
      const result = await activate(config);
      console.log(JSON.stringify({ initialized: true, authorized: Boolean(controlPlaneUrl), ...result }, null, 2));
      break;
    }
    case "install": {
      const result = await install(loadConfig(paths));
      await launchCodex(result.config || loadConfig(paths), process.cwd());
      console.log(JSON.stringify({ installed: true, codex_opened: true, ...result }, null, 2));
      break;
    }
    case "sync": {
      console.log(JSON.stringify(await syncModels(loadCandidateConfig()), null, 2));
      break;
    }
    case "status": {
      const config = loadConfig(paths);
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
    case "app": {
      const config = loadConfig(paths);
      const current = await health(config);
      if (
        !current?.ok
        || !current.ready
        || !Number.isInteger(current.model_count)
        || current.model_count < 1
      ) {
        throw new Error("9codex service is not ready with at least one model");
      }
      await launchCodex(
        config,
        args[0] ? path.resolve(args[0]) : process.cwd(),
      );
      break;
    }
    case "restart":
      repairLocalModelState(paths, loadConfig(paths));
      await restartService(paths);
      if (!(await waitForHealth(loadConfig(paths)))) throw new Error("9codex service restart failed");
      await launchCodex(loadConfig(paths), process.cwd());
      console.log("9codex service restarted; Codex opened without terminating the existing session.");
      break;
    case "codex-launch-worker": {
      const workspace = args[0];
      await launchCodex(loadConfig(paths), workspace || paths.home, {
        bridge: false,
      });
      break;
    }
    case "auth-token":
      process.stdout.write(`${loadConfig(paths).local.token}\n`);
      break;
    case "models": {
      const current = loadConfig(paths);
      const [action = "list", ...modelIds] = args;
      if (!["list", "select", "all"].includes(action)) {
        throw new Error("Commands: models list, models select <model...>, models all");
      }
      const reconciled = await reconcileModelState(paths, current, {
        prepareCandidate: action === "select"
          ? (candidate) => selectEnabledModels(candidate, modelIds)
          : action === "all"
            ? (candidate) => enableAllModels(candidate)
            : undefined,
      });
      const config = reconciled.config;
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
        packageRoot,
        policy: config.updates,
        activate: (installation) => runInstalledCli(installation, "install"),
        health: async (version) => Boolean(await waitForHealth(loadConfig(paths), 20_000, version)),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "update-worker": {
      const [target, token] = args;
      if (!ownsUpdateLock(paths, token, target)) {
        throw new Error("Automatic update lock is missing or invalid");
      }
      try {
        const config = loadConfig(paths);
        const pending = readPendingUpdate(paths);
        if (
          pending?.version !== target
          || pending.channel !== config.updates.channel
          || pending.registry !== config.updates.npm_registry
        ) {
          throw new Error("Pending automatic update no longer matches local policy");
        }
        await waitForGatewayIdle(paths);
        const result = await runStagedUpdate({
          package: "@hooliy/9codex",
          version: target,
          channel: pending.channel,
          registry: pending.registry,
        }, {
          currentVersion: packageInfo.version,
          packageRoot,
          policy: config.updates,
          beforeActivate: () => waitForGatewayIdle(paths),
          activate: (installation) => runInstalledCli(installation, "install"),
          health: async (version) => Boolean(await waitForHealth(loadConfig(paths), 20_000, version)),
        });
        try { fs.unlinkSync(paths.pendingUpdate); } catch {}
        console.log(JSON.stringify(result, null, 2));
      } finally {
        releaseUpdateLock(paths, token);
      }
      break;
    }
    case "version":
      console.log(packageInfo.version);
      break;
    case "uninstall":
      await uninstallService(paths);
      console.log("9codex service removed. Codex files were never modified. Local 9codex configuration was retained.");
      break;
    case "daemon":
      await runDaemon(paths, {
        version: packageInfo.version,
        nodePath: process.execPath,
        cliPath,
        onError: (error) => console.error(`9codex daemon: ${error.message}`),
        updatePackage: async (request) => {
          const active = loadConfig(paths);
          return runStagedUpdate(request, {
            currentVersion: packageInfo.version,
            packageRoot,
            policy: active.updates,
            activate: (installation) => runInstalledCli(installation, "install"),
            health: async (version) => Boolean(await waitForHealth(loadConfig(paths), 20_000, version)),
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
      throw new Error("Commands: init, sync, install, app, status, models, restart, auth-token, update, version, uninstall");
  }
} catch (error) {
  console.error(`9codex error: ${error.message}`);
  process.exitCode = 1;
}
