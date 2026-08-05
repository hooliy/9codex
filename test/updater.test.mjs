import assert from "node:assert/strict";
import test from "node:test";

import {
  UpdateError,
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

test("Windows npm updates run cmd shims through a hidden shell", () => {
  assert.deepEqual(npmSpawnOptions("win32"), {
    stdio: "inherit",
    windowsHide: true,
    shell: true,
  });
  assert.deepEqual(npmSpawnOptions("linux"), {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
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
      install: async (spec, registry) => { calls.push(`install:${spec}:${registry}`); },
      activate: async () => { calls.push("install-runtime"); },
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
    "install-runtime",
    "health",
    "install:@hooliy/9codex@3.0.0:https://registry.npmjs.org",
    "install-runtime",
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
    install: async (spec) => { calls.push(`download:${spec}`); },
    activate: async () => { calls.push("9codex install"); },
    health: async () => { calls.push("health"); return true; },
  });

  assert.deepEqual(calls, [
    "download:@hooliy/9codex@3.0.1",
    "9codex install",
    "health",
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

  assert.deepEqual(calls, ["9codex install", "health"]);
  assert.deepEqual(result, { updated: false, version: "3.0.1", rolled_back: false });
});
