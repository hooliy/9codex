import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reconcileAndActivateInstallation } from "../lib/activation.mjs";
import { defaultConfig } from "../lib/config.mjs";
import { reconcileModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";
import {
  UpdateError,
  npmInstallCommand,
  npmSpawnOptions,
  resolveLatestVersion,
  runStagedUpdate,
  validateUpdateRequest,
} from "../lib/updater.mjs";

const policy = {
  enabled: true,
  channel: "stable",
  npm_registry: "https://registry.npmjs.org",
};

test("Windows npm updates never use Node shell argument concatenation", () => {
  assert.deepEqual(npmSpawnOptions("win32"), {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  assert.deepEqual(npmSpawnOptions("linux"), {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
});

test("updates the exact global prefix that owns the running 9codex package", () => {
  assert.deepEqual(npmInstallCommand(
    "@hooliy/9codex@1.1.21",
    "https://registry.npmjs.org",
    {
      platform: "darwin",
      execPath: "/opt/node/bin/node",
      packageRoot: "/opt/node/lib/node_modules/@hooliy/9codex",
    },
  ), {
    file: "/opt/node/bin/node",
    cliPath: "/opt/node/lib/node_modules/@hooliy/9codex/bin/9codex.mjs",
    args: [
      "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
      "install",
      "-g",
      "@hooliy/9codex@1.1.21",
      "--prefix",
      "/opt/node",
      "--registry",
      "https://registry.npmjs.org",
    ],
  });
});

test("Windows updates the active package prefix without cmd.exe", () => {
  assert.deepEqual(npmInstallCommand(
    "@hooliy/9codex@1.1.21",
    "https://registry.npmjs.org",
    {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      packageRoot: "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@hooliy\\9codex",
    },
  ), {
    file: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@hooliy\\9codex\\bin\\9codex.mjs",
    args: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "install",
      "-g",
      "@hooliy/9codex@1.1.21",
      "--prefix",
      "C:\\Users\\Administrator\\AppData\\Roaming\\npm",
      "--registry",
      "https://registry.npmjs.org",
    ],
  });
});

test("accepts only the fixed 9codex package, exact semver, channel, and registry", () => {
  assert.deepEqual(
    validateUpdateRequest({
      package: "@hooliy/9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    }, policy),
    {
      package: "@hooliy/9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    },
  );
  for (const request of [
    { package: "evil", version: "3.0.1", channel: "stable", registry: policy.npm_registry },
    { package: "@hooliy/9codex", version: "latest", channel: "stable", registry: policy.npm_registry },
    { package: "@hooliy/9codex", version: "3.0.1", channel: "dev", registry: policy.npm_registry },
    { package: "@hooliy/9codex", version: "3.0.1", channel: "stable", registry: "https://evil.example" },
    { package: "@hooliy/9codex", version: "3.0.1", channel: "stable", registry: policy.npm_registry, command: "whoami" },
  ]) {
    assert.throws(
      () => validateUpdateRequest(request, policy),
      (error) => error instanceof UpdateError && error.code === "invalid_update_request",
    );
  }
});

test("rolls back to the prior package version when the new service fails health checks", async () => {
  const calls = [];
  let healthChecks = 0;
  await assert.rejects(
    () => runStagedUpdate({
      package: "@hooliy/9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    }, {
      currentVersion: "3.0.0",
      policy,
      install: async (spec, registry) => {
        calls.push(`install:${spec}:${registry}`);
        return { cliPath: `/installed/${spec}/bin/9codex.mjs` };
      },
      activate: async ({ cliPath }) => { calls.push(`activate:${cliPath}`); },
      health: async () => {
        calls.push("health");
        healthChecks += 1;
        return healthChecks > 1;
      },
    }),
    (error) => error.code === "update_health_failed",
  );

  assert.deepEqual(calls, [
    "install:@hooliy/9codex@3.0.1:https://registry.npmjs.org",
    "activate:/installed/@hooliy/9codex@3.0.1/bin/9codex.mjs",
    "health",
    "install:@hooliy/9codex@3.0.0:https://registry.npmjs.org",
    "activate:/installed/@hooliy/9codex@3.0.0/bin/9codex.mjs",
    "health",
  ]);
});

test("resolves the latest stable npm version when update has no explicit version", async () => {
  const requests = [];
  const version = await resolveLatestVersion(policy, {
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ "dist-tags": { latest: "3.2.1" } }),
      };
    },
  });

  assert.equal(version, "3.2.1");
  assert.deepEqual(requests, [
    "https://registry.npmjs.org/%40hooliy%2F9codex",
  ]);
});

test("successful update activates the newly installed CLI before checking health", async () => {
  const calls = [];
  const result = await runStagedUpdate({
    package: "@hooliy/9codex",
    version: "3.0.1",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }, {
    currentVersion: "3.0.0",
    policy,
    install: async (spec) => {
      calls.push(`download:${spec}`);
      return { cliPath: "/new-prefix/lib/node_modules/@hooliy/9codex/bin/9codex.mjs" };
    },
    activate: async ({ cliPath }) => { calls.push(`activate:${cliPath}`); },
    health: async () => { calls.push("health"); return true; },
  });

  assert.deepEqual(calls, [
    "download:@hooliy/9codex@3.0.1",
    "activate:/new-prefix/lib/node_modules/@hooliy/9codex/bin/9codex.mjs",
    "health",
  ]);
  assert.deepEqual(result, { updated: true, version: "3.0.1", rolled_back: false });
});

test("automatic update activation reconciles a legacy catalog before service activation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-updater-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "secret";
  config.upstream.default_model = "model-a";
  await reconcileModelState(paths, config, {
    authoritativeModels: [{ id: "model-a", context_window: 1_050_000 }],
  });
  fs.writeFileSync(paths.catalog, `${JSON.stringify({
    models: [{
      slug: "9codex/model-a",
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      effective_context_window_percent: 95,
    }],
  }, null, 2)}\n`);
  const calls = [];

  const result = await runStagedUpdate({
    package: "@hooliy/9codex",
    version: "3.0.1",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }, {
    currentVersion: "3.0.0",
    policy,
    install: async (spec) => { calls.push(`download:${spec}`); },
    activate: () => reconcileAndActivateInstallation(paths, config, {
      fetchImpl: async (url) => {
        calls.push(`models:${url}`);
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "model-a", context_window: 1_050_000 }],
          }),
        };
      },
      installService: async () => { calls.push("install-service"); },
      restartService: async () => { calls.push("restart-service"); },
      waitForHealth: async () => {
        calls.push("activation-health");
        return { ok: true, ready: true };
      },
      syncSkills: () => [],
      restartCodex: async () => ({ codex_restarted: true }),
    }),
    health: async () => {
      calls.push("update-health");
      return true;
    },
  });

  const catalog = JSON.parse(fs.readFileSync(paths.catalog, "utf8"));
  assert.equal(catalog.models[0].slug, "model-a");
  assert.equal(catalog.models[0].effective_context_window_percent, 90);
  assert.deepEqual(calls, [
    "download:@hooliy/9codex@3.0.1",
    "models:https://router.example/v1/models",
    "install-service",
    "restart-service",
    "activation-health",
    "update-health",
  ]);
  assert.deepEqual(result, { updated: true, version: "3.0.1", rolled_back: false });
});

test("update never downgrades when npm latest is older than the installed version", async () => {
  const calls = [];
  const result = await runStagedUpdate({
    package: "@hooliy/9codex",
    version: "3.0.0",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }, {
    currentVersion: "3.0.1",
    policy,
    install: async () => { calls.push("download"); },
    activate: async () => { calls.push("9codex install"); },
    health: async () => { calls.push("health"); return true; },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { updated: false, version: "3.0.1", rolled_back: false });
});
