import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultConfig,
  migrateLegacyConfig,
  redactConfig,
  saveConfigAtomic,
} from "../lib/config.mjs";
import { reconcileModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function temporaryHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "9codex-config-test-"));
}

test("legacy migration returns a candidate and persists only through reconciliation", async () => {
  const home = temporaryHome();
  const paths = resolvePaths(home);
  fs.mkdirSync(path.dirname(paths.legacyConfig), { recursive: true });
  fs.writeFileSync(paths.legacyConfig, JSON.stringify({
    router9_url: "https://router.example/v1",
    router9_key: "upstream-secret",
    bridge_port: 12001,
    model: "yuanpi-auto",
    image_model: "cx/image",
    model_refresh_interval: 480,
    inject_config: true,
  }));

  const migrated = migrateLegacyConfig(paths, {
    randomBytes: () => Buffer.from("0123456789abcdef", "utf8"),
  });

  assert.equal(migrated.schema_version, 1);
  assert.equal(migrated.local.port, 12001);
  assert.match(migrated.local.token, /^9codex_local_/);
  assert.equal(migrated.upstream.base_url, "https://router.example/v1");
  assert.equal(migrated.upstream.api_key, "upstream-secret");
  assert.equal(migrated.upstream.default_model, "yuanpi-auto");
  assert.equal(migrated.upstream.image_model, "cx/image");
  assert.equal(migrated.models.namespace, "9codex");
  assert.equal(migrated.models.refresh_interval_seconds, 480);
  assert.equal(migrated.codex.inject_config, true);
  assert.equal(migrated.codex.restart_policy, "automatic");
  assert.equal(fs.existsSync(paths.config), false);
  await reconcileModelState(paths, migrated, {
    authoritativeModels: [{ id: "yuanpi-auto", context_window: 1_050_000 }],
  });
  assert.equal(JSON.parse(fs.readFileSync(paths.config)).upstream.api_key, "upstream-secret");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600);
  }
});

test("default configuration contains no relay address or API key", () => {
  const config = defaultConfig();

  assert.equal(config.upstream.base_url, null);
  assert.equal(config.upstream.api_key, null);
});

test("redacts every credential from diagnostics", () => {
  const redacted = redactConfig({
    control_plane: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    },
    local: { token: "local-secret" },
    upstream: { api_key: "upstream-secret" },
  });
  const text = JSON.stringify(redacted);

  for (const secret of ["access-secret", "refresh-secret", "local-secret", "upstream-secret"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(redacted.local.token, "[REDACTED]");
  assert.equal(redacted.upstream.api_key, "[REDACTED]");
});

test("rejects invalid pending config without replacing active or last-good config", () => {
  const home = temporaryHome();
  const paths = resolvePaths(home);
  const valid = {
    schema_version: 1,
    installation: { installation_id: "ins_test" },
    control_plane: { base_url: null },
    local: { host: "127.0.0.1", port: 10101, token: "9codex_local_test" },
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "model-a",
      image_model: "image-a"
    },
    models: { namespace: "9codex", refresh_interval_seconds: 300 },
    updates: { enabled: true, channel: "stable", auto_install: true },
    codex: { inject_config: true, restart_policy: "automatic", restart_required: false }
  };
  saveConfigAtomic(paths, valid);
  saveConfigAtomic(paths, { ...valid, upstream: { ...valid.upstream, default_model: "model-b" } });
  const activeBefore = fs.readFileSync(paths.config, "utf8");
  const lastGoodBefore = fs.readFileSync(paths.lastGoodConfig, "utf8");

  assert.throws(
    () => saveConfigAtomic(paths, { ...valid, local: { ...valid.local, port: 70000 } }),
    /local\.port/,
  );
  assert.equal(fs.readFileSync(paths.config, "utf8"), activeBefore);
  assert.equal(fs.readFileSync(paths.lastGoodConfig, "utf8"), lastGoodBefore);
});
