import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  injectCodexConfig,
  migrateCodexHistoryProviders,
  repairCodexHistoryProviders,
  restoreCodexConfig,
  restoreCodexHistoryProviders,
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

test("history task rebind moves every persisted provider to 9codex", () => {
  const { paths } = fixture();
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)");
  insert.run("old-openai", "openai");
  insert.run("old-bridge", "codex_bridge");
  insert.run("current-9codex", "9codex");
  insert.run("unrelated-ollama", "ollama");
  database.close();

  const result = migrateCodexHistoryProviders(paths);
  const migrated = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  const providers = migrated.prepare("SELECT id, model_provider FROM threads ORDER BY id").all()
    .map((row) => ({ ...row }));
  migrated.close();

  assert.deepEqual(result, { databases: 1, migrated: 3, files: 0, busy: 0 });
  assert.deepEqual(providers, [
    { id: "current-9codex", model_provider: "9codex" },
    { id: "old-bridge", model_provider: "9codex" },
    { id: "old-openai", model_provider: "9codex" },
    { id: "unrelated-ollama", model_provider: "9codex" },
  ]);
  assert.equal(fs.statSync(paths.historyProviderState).mode & 0o777, 0o600);
});

test("history compatibility restoration only reverts rows previously migrated by 9codex", () => {
  const { paths } = fixture();
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)");
  insert.run("old-openai", "openai");
  insert.run("current-9codex", "9codex");
  database.close();

  migrateCodexHistoryProviders(paths);
  assert.deepEqual(restoreCodexHistoryProviders(paths), { databases: 1, restored: 1, files: 0 });

  const restored = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  const providers = restored.prepare("SELECT id, model_provider FROM threads ORDER BY id").all()
    .map((row) => ({ ...row }));
  restored.close();
  assert.deepEqual(providers, [
    { id: "current-9codex", model_provider: "9codex" },
    { id: "old-openai", model_provider: "openai" },
  ]);
  assert.equal(fs.existsSync(paths.historyProviderState), false);
});

test("history compatibility updates only rollout provider metadata so Codex reindexing keeps old chats visible", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "08", "01");
  const rollout = path.join(sessionDirectory, "rollout-old.jsonl");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const original = [
    JSON.stringify({
      timestamp: "2026-08-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "old-openai", cwd: "/tmp/project", model_provider: "openai" },
    }),
    JSON.stringify({ type: "event_msg", payload: { message: "正文必须保持原样" } }),
    "",
  ].join("\n");
  fs.writeFileSync(rollout, original);
  const originalTimestamp = new Date("2025-01-02T03:04:05.000Z");
  fs.utimesSync(rollout, originalTimestamp, originalTimestamp);

  const result = migrateCodexHistoryProviders(paths);
  const migrated = fs.readFileSync(rollout, "utf8").split("\n");

  assert.equal(result.files, 1);
  assert.equal(JSON.parse(migrated[0]).payload.model_provider, "9codex");
  assert.equal(`${migrated.slice(1).join("\n")}`, original.slice(original.indexOf("\n") + 1));
  assert.equal(fs.statSync(rollout).mtimeMs, originalTimestamp.getTime());

  restoreCodexHistoryProviders(paths);
  assert.equal(fs.readFileSync(rollout, "utf8"), original);
});

test("history compatibility still migrates rollout metadata while Codex holds its SQLite writer lock", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "08", "01");
  const rollout = path.join(sessionDirectory, "rollout-locked.jsonl");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "locked-openai", model_provider: "openai" },
  })}\n`);
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("locked-openai", "openai");
  database.exec("BEGIN EXCLUSIVE");

  const result = migrateCodexHistoryProviders(paths);

  assert.equal(result.files, 1);
  assert.equal(result.busy, 1);
  assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n", 1)[0]).payload.model_provider, "9codex");
  database.exec("ROLLBACK");
  database.close();
});

test("history repair retries after Codex releases its SQLite writer lock", async () => {
  const { paths } = fixture();
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("locked-spanai", "spanai");
  database.exec("BEGIN EXCLUSIVE");
  let waits = 0;

  const result = await repairCodexHistoryProviders(paths, {
    attempts: 2,
    wait: async () => {
      waits += 1;
      database.exec("ROLLBACK");
      database.close();
    },
  });

  assert.equal(waits, 1);
  assert.equal(result.busy, 0);
  assert.equal(result.migrated, 1);
  const migrated = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  assert.equal(
    migrated.prepare("SELECT model_provider FROM threads WHERE id = ?").get("locked-spanai").model_provider,
    "9codex",
  );
  migrated.close();
});

test("history restoration restores rollout metadata even while Codex holds its SQLite writer lock", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "08", "01");
  const rollout = path.join(sessionDirectory, "rollout-restore-locked.jsonl");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const original = `${JSON.stringify({
    type: "session_meta",
    payload: { id: "restore-locked", model_provider: "openai" },
  })}\n`;
  fs.writeFileSync(rollout, original);
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("restore-locked", "openai");
  database.close();
  migrateCodexHistoryProviders(paths);

  const lock = new DatabaseSync(paths.codexStateDb);
  lock.exec("BEGIN EXCLUSIVE");
  const result = restoreCodexHistoryProviders(paths);

  assert.equal(result.files, 1);
  assert.equal(fs.readFileSync(rollout, "utf8"), original);
  assert.equal(fs.existsSync(paths.historyProviderState), true);
  lock.exec("ROLLBACK");
  lock.close();
});

test("history compatibility migrates legacy spanai sessions to 9codex", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "08", "01");
  const rollout = path.join(sessionDirectory, "rollout-spanai.jsonl");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "old-spanai", model_provider: "spanai" },
  })}\n`);
  const database = new DatabaseSync(paths.codexStateDb);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("old-spanai", "spanai");
  database.close();

  const result = migrateCodexHistoryProviders(paths);

  assert.equal(result.files, 1);
  assert.equal(JSON.parse(fs.readFileSync(rollout, "utf8").split("\n", 1)[0]).payload.model_provider, "9codex");
  const migrated = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  assert.equal(
    migrated.prepare("SELECT model_provider FROM threads WHERE id = ?").get("old-spanai").model_provider,
    "9codex",
  );
  migrated.close();
});

test("injectCodexConfig migrates legacy spanai history during install", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "07", "31");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, "rollout-init-spanai.jsonl");
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "init-spanai", model_provider: "spanai" },
  })}\n`);

  // injectCodexConfig is what install() calls; it must trigger migration.
  injectCodexConfig(paths, config(), {
    nodePath: "node",
    cliPath: "9codex.mjs",
  });

  const migrated = JSON.parse(fs.readFileSync(rollout, "utf8").split("\n", 1)[0]);
  assert.equal(migrated.payload.model_provider, "9codex");
});

test("install rebinds every persisted task runtime field without rewriting conversation text", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "07", "28");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, "rollout-stale-runtime.jsonl");
  const events = [
    {
      type: "session_meta",
      payload: { id: "stale-runtime", model_provider: "9codex" },
    },
    {
      type: "event_msg",
      payload: {
        thread_settings: {
          model: "spanai/fangan",
          collaboration_mode: { settings: { model: "spanai/fangan" } },
        },
      },
    },
    {
      type: "turn_context",
      payload: {
        model: "oldgateway/example-model",
        collaboration_mode: { settings: { model: "oldgateway/example-model" } },
      },
    },
    {
      type: "event_msg",
      payload: {
        message: "用户正文 model_provider=spanai，模型 spanai/fangan，不允许改写",
      },
    },
  ];
  fs.writeFileSync(rollout, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const database = new DatabaseSync(paths.codexStateDb);
  database.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, model TEXT NOT NULL)",
  );
  database.prepare(
    "INSERT INTO threads (id, model_provider, model) VALUES (?, ?, ?)",
  ).run("stale-runtime", "9codex", "spanai/fangan");
  database.close();

  injectCodexConfig(paths, config(), { nodePath: "node", cliPath: "9codex.mjs" });

  const rebound = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  assert.deepEqual(
    { ...rebound.prepare(
      "SELECT model_provider, model FROM threads WHERE id = ?",
    ).get("stale-runtime") },
    { model_provider: "9codex", model: "9codex/fangan" },
  );
  rebound.close();

  const migrated = fs.readFileSync(rollout, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(migrated[0].payload.model_provider, "9codex");
  assert.equal(migrated[1].payload.thread_settings.model, "9codex/fangan");
  assert.equal(
    migrated[1].payload.thread_settings.collaboration_mode.settings.model,
    "9codex/fangan",
  );
  assert.equal(migrated[2].payload.model, "9codex/example-model");
  assert.equal(
    migrated[2].payload.collaboration_mode.settings.model,
    "9codex/example-model",
  );
  assert.equal(migrated[3].payload.message, events[3].payload.message);
});

test("install upgrades an earlier provider-only repair and fixes the remaining model namespace", () => {
  const { paths } = fixture();
  const sessionDirectory = path.join(paths.codexHome, "sessions", "2026", "07", "28");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, "rollout-partially-repaired.jsonl");
  const originalFirstLine = JSON.stringify({
    type: "session_meta",
    payload: { id: "partially-repaired", model_provider: "spanai" },
  });
  const currentFirstLine = JSON.stringify({
    type: "session_meta",
    payload: { id: "partially-repaired", model_provider: "9codex" },
  });
  fs.writeFileSync(rollout, [
    currentFirstLine,
    JSON.stringify({
      type: "turn_context",
      payload: { model: "spanai/fangan" },
    }),
    "",
  ].join("\n"));

  const database = new DatabaseSync(paths.codexStateDb);
  database.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, model TEXT NOT NULL)",
  );
  database.prepare(
    "INSERT INTO threads (id, model_provider, model) VALUES (?, ?, ?)",
  ).run("partially-repaired", "9codex", "spanai/fangan");
  database.close();
  fs.mkdirSync(path.dirname(paths.historyProviderState), { recursive: true });
  fs.writeFileSync(paths.historyProviderState, `${JSON.stringify({
    version: 1,
    rows: [{
      database: paths.codexStateDb,
      id: "partially-repaired",
      provider: "spanai",
    }],
    files: [{
      file: rollout,
      first_line_base64: Buffer.from(originalFirstLine).toString("base64"),
    }],
  })}\n`);

  injectCodexConfig(paths, config(), { nodePath: "node", cliPath: "9codex.mjs" });

  const rebound = new DatabaseSync(paths.codexStateDb, { readOnly: true });
  assert.deepEqual(
    { ...rebound.prepare(
      "SELECT model_provider, model FROM threads WHERE id = ?",
    ).get("partially-repaired") },
    { model_provider: "9codex", model: "9codex/fangan" },
  );
  rebound.close();
  const migrated = fs.readFileSync(rollout, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(migrated[1].payload.model, "9codex/fangan");
});
