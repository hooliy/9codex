import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  injectCodexConfig,
  restoreCodexConfig,
} from "../lib/codex-config.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-codex-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.codexHome, { recursive: true });
  return { home, paths };
}

function config() {
  return {
    local: { port: 10101, token: "local-test-token" },
    upstream: { default_model: "vendor/model-a" },
    codex: { inject_config: true },
  };
}

test("injects 9codex while preserving every unrelated Codex setting", () => {
  const { paths } = fixture();
  const original = [
    "model = \"old-model\"",
    "model_provider = \"old-provider\"",
    "approval_policy = \"on-request\"",
    "preferred_auth_method = \"chatgpt\"",
    "",
    "[features]",
    "multi_agent = true",
    "",
    "[mcp_servers.example]",
    "command = \"example-server\"",
    "",
  ].join("\n");
  fs.writeFileSync(paths.codexConfig, original);

  injectCodexConfig(paths, config(), {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Administrator\\9codex\\bin\\9codex.mjs",
  });
  const injected = fs.readFileSync(paths.codexConfig, "utf8");

  assert.match(injected, /# BEGIN 9codex root/);
  assert.match(injected, /model = "9codex\/vendor-model-a"/);
  assert.match(injected, /model_provider = "9codex"/);
  assert.match(injected, /\[model_providers\.9codex\]/);
  assert.match(injected, /wire_api = "responses"/);
  assert.match(injected, /supports_websockets = false/);
  assert.doesNotMatch(injected, /requires_openai_auth/);
  assert.match(injected, /experimental_bearer_token = "local-test-token"/);
  assert.match(
    injected,
    /http_headers = \{ "x-openai-actor-authorization" = "9codex-local" \}/,
  );
  assert.doesNotMatch(injected, /\[model_providers\.9codex\.auth\]/);
  assert.match(injected, /# BEGIN 9codex mcp/);
  assert.match(injected, /\[mcp_servers\.9codex\]/);
  assert.match(injected, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  assert.match(injected, /args = \["C:\\\\Users\\\\Administrator\\\\9codex\\\\bin\\\\9codex\.mjs", "mcp"\]/);
  assert.match(injected, /default_tools_approval_mode = "approve"/);
  assert.match(injected, /approval_policy = "on-request"/);
  assert.match(injected, /preferred_auth_method = "chatgpt"/);
  assert.match(injected, /\[features\]\nmulti_agent = true/);
  assert.match(injected, /\[mcp_servers\.example\]\ncommand = "example-server"/);
  assert.doesNotMatch(injected, /model = "old-model"/);
  assert.doesNotMatch(injected, /model_provider = "old-provider"/);
});

test("reinjection is idempotent and uninstall restores the exact original bytes", () => {
  const { paths } = fixture();
  const original = "approval_policy = \"never\"\r\n\r\n[features]\r\nweb_search = true\r\n";
  fs.writeFileSync(paths.codexConfig, original);

  const runtime = { nodePath: process.execPath, cliPath: "/opt/9codex/bin/9codex.mjs" };
  injectCodexConfig(paths, config(), runtime);
  const first = fs.readFileSync(paths.codexConfig, "utf8");
  injectCodexConfig(paths, config(), runtime);
  assert.equal(fs.readFileSync(paths.codexConfig, "utf8"), first);

  restoreCodexConfig(paths);
  assert.deepEqual(fs.readFileSync(paths.codexConfig), Buffer.from(original));
  assert.equal(fs.existsSync(paths.codexState), false);
});

test("configuration injection never rewrites persisted task history", () => {
  const { paths } = fixture();
  const database = path.join(paths.codexHome, "state_5.sqlite");
  const rollout = path.join(paths.codexHome, "sessions", "2026", "08", "05", "rollout.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(database, Buffer.from([0, 1, 2, 3, 4]));
  fs.writeFileSync(rollout, '{"type":"turn_context","payload":{"model":"openai/fangan"}}\n');
  const beforeDatabase = fs.readFileSync(database);
  const beforeRollout = fs.readFileSync(rollout);

  injectCodexConfig(paths, config(), { nodePath: "node", cliPath: "9codex.mjs" });

  assert.deepEqual(fs.readFileSync(database), beforeDatabase);
  assert.deepEqual(fs.readFileSync(rollout), beforeRollout);
});
