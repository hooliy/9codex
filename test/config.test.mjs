import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultConfig,
  redactConfig,
  saveConfigAtomic,
  validateConfig,
} from "../lib/config.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function temporaryHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "9codex-config-test-"));
}

test("default configuration contains no relay address or API key", () => {
  const config = defaultConfig();

  assert.equal(config.upstream.base_url, null);
  assert.equal(config.upstream.api_key, null);
  assert.equal("team" in config, false);
  assert.equal("codex" in config, false);
});

test("redacts every credential from diagnostics", () => {
  const redacted = redactConfig({
    control_plane: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    },
    local: { token: "local-secret" },
    upstream: { api_key: "upstream-secret" },
    nested: {
      env: { PRIVATE_API_KEY: "nested-secret" },
    },
  });
  const text = JSON.stringify(redacted);

  for (const secret of [
    "access-secret",
    "refresh-secret",
    "local-secret",
    "upstream-secret",
    "nested-secret",
  ]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal(redacted.local.token, "[REDACTED]");
  assert.equal(redacted.upstream.api_key, "[REDACTED]");
  assert.equal(redacted.nested.env.PRIVATE_API_KEY, "[REDACTED]");
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
    updates: { enabled: true, channel: "stable", auto_install: false },
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
