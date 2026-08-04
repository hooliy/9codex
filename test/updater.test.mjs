import assert from "node:assert/strict";
import test from "node:test";

import { UpdateError, runStagedUpdate, validateUpdateRequest } from "../lib/updater.mjs";

const policy = {
  enabled: true,
  channel: "stable",
  npm_registry: "https://registry.npmjs.org",
};

test("accepts only the fixed 9codex package, exact semver, channel, and registry", () => {
  assert.deepEqual(
    validateUpdateRequest({
      package: "9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    }, policy),
    {
      package: "9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    },
  );
  for (const request of [
    { package: "evil", version: "3.0.1", channel: "stable", registry: policy.npm_registry },
    { package: "9codex", version: "latest", channel: "stable", registry: policy.npm_registry },
    { package: "9codex", version: "3.0.1", channel: "dev", registry: policy.npm_registry },
    { package: "9codex", version: "3.0.1", channel: "stable", registry: "https://evil.example" },
    { package: "9codex", version: "3.0.1", channel: "stable", registry: policy.npm_registry, command: "whoami" },
  ]) {
    assert.throws(
      () => validateUpdateRequest(request, policy),
      (error) => error instanceof UpdateError && error.code === "invalid_update_request",
    );
  }
});

test("rolls back to the prior package version when the new service fails health checks", async () => {
  const calls = [];
  await assert.rejects(
    () => runStagedUpdate({
      package: "9codex",
      version: "3.0.1",
      channel: "stable",
      registry: "https://registry.npmjs.org",
    }, {
      currentVersion: "3.0.0",
      policy,
      install: async (spec, registry) => { calls.push(`install:${spec}:${registry}`); },
      restart: async () => { calls.push("restart"); },
      health: async () => { calls.push("health"); return false; },
    }),
    (error) => error.code === "update_health_failed",
  );

  assert.deepEqual(calls, [
    "install:9codex@3.0.1:https://registry.npmjs.org",
    "restart",
    "health",
    "install:9codex@3.0.0:https://registry.npmjs.org",
    "restart",
  ]);
});
