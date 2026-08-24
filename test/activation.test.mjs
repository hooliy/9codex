import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateInstallation,
  reconcileAndActivateInstallation,
} from "../lib/activation.mjs";
import { defaultConfig, loadConfig } from "../lib/config.mjs";
import { reconcileModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function stateBytes(paths) {
  return Object.fromEntries(
    ["config", "catalog", "modelMap"].map((key) => [key, fs.readFileSync(paths[key])]),
  );
}

function activationDependencies(overrides = {}) {
  return {
    installService: async () => {},
    restartService: async () => {},
    waitForHealth: async () => ({ ok: true, ready: true, model_count: 1 }),
    ...overrides,
  };
}

test("installation activates only an already validated model state", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  config.upstream.default_model = "model-a";
  const active = await reconcileModelState(paths, config, {
    authoritativeModels: [{ id: "model-a", context_window: 1_050_000 }],
  });
  const order = [];

  const result = await activateInstallation(paths, active.config, {
    installService: async () => { order.push("install-service"); },
    restartService: async () => { order.push("restart-service"); },
    waitForHealth: async () => {
      order.push("health");
      return { ok: true, ready: true, model_count: 1 };
    },
  });

  assert.deepEqual(order, ["install-service", "restart-service", "health"]);
  assert.equal(result.health.ready, true);
});

test("installation rejects healthy-looking service without models", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  config.upstream.default_model = "model-a";
  const active = await reconcileModelState(paths, config, {
    authoritativeModels: [{ id: "model-a", context_window: 1_050_000 }],
  });

  await assert.rejects(
    () => activateInstallation(paths, active.config, activationDependencies({
      waitForHealth: async () => ({ ok: true, ready: true, model_count: 0 }),
    })),
    /at least one model/i,
  );
});

test("installation rejects invalid state before service operations", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  const calls = [];

  await assert.rejects(
    () => activateInstallation(paths, config, {
      installService: async () => calls.push("install"),
    }),
    /model state|model metadata|ENOENT/i,
  );
  assert.deepEqual(calls, []);
});

test("install rewrites inconsistent catalog state from current authoritative metadata", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
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
  const order = [];

  const result = await reconcileAndActivateInstallation(
    paths,
    config,
    activationDependencies({
      fetchImpl: async (url) => {
        order.push(`models:${url}`);
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "model-a", context_window: 1_050_000 }],
          }),
        };
      },
      installService: async () => { order.push("install-service"); },
    }),
  );

  const catalog = JSON.parse(fs.readFileSync(paths.catalog, "utf8"));
  assert.equal(loadConfig(paths).models.available[0].id, "model-a");
  assert.equal("config" in result, false);
  assert.equal(catalog.models[0].slug, "model-a");
  assert.equal(catalog.models[0].effective_context_window_percent, 100);
  assert.deepEqual(order, [
    "models:https://router.example/v1/models",
    "install-service",
  ]);
});

test("install rejects incomplete upstream metadata before service activation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  config.upstream.default_model = "fangan";

  let activations = 0;
  await assert.rejects(
    () => reconcileAndActivateInstallation(
      paths,
      config,
      activationDependencies({
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ data: [{ id: "fangan" }] }),
        }),
        installService: async () => { activations += 1; },
      }),
    ),
    /context_window.*fangan|fangan.*context_window/,
  );

  assert.equal(activations, 0);
  assert.equal(fs.existsSync(paths.config), false);
});

test("install preserves every active model-state byte when upstream reconciliation fails", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activation-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "key";
  config.upstream.default_model = "model-a";
  await reconcileModelState(paths, config, {
    authoritativeModels: [{ id: "model-a", context_window: 1_050_000 }],
  });
  fs.writeFileSync(paths.catalog, '{"models":[{"slug":"9codex/model-a","effective_context_window_percent":95}]}\n');
  const before = stateBytes(paths);
  let activations = 0;

  await assert.rejects(
    () => reconcileAndActivateInstallation(
      paths,
      config,
      activationDependencies({
        fetchImpl: async () => { throw new Error("model upstream unavailable"); },
        installService: async () => { activations += 1; },
      }),
    ),
    /model upstream unavailable/,
  );

  assert.deepEqual(stateBytes(paths), before);
  assert.equal(activations, 0);
});
