import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const ROOT_KEYS = new Set(["model", "model_provider", "model_catalog_json"]);
const MARKERS = {
  rootStart: "# BEGIN 9codex root",
  rootEnd: "# END 9codex root",
  providerStart: "# BEGIN 9codex provider",
  providerEnd: "# END 9codex provider",
  mcpStart: "# BEGIN 9codex mcp",
  mcpEnd: "# END 9codex mcp",
};
function publicModel(id) {
  return `9codex/${String(id).replaceAll("/", "-")}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function stripManagedBlocks(lines) {
  const output = [];
  let dropping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === MARKERS.rootStart ||
      trimmed === MARKERS.providerStart ||
      trimmed === MARKERS.mcpStart
    ) {
      dropping = true;
      continue;
    }
    if (
      trimmed === MARKERS.rootEnd ||
      trimmed === MARKERS.providerEnd ||
      trimmed === MARKERS.mcpEnd
    ) {
      dropping = false;
      continue;
    }
    if (!dropping) output.push(line);
  }
  return output;
}

function stripOwnedRootKeys(lines) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  return lines.filter((line, index) => {
    if (index >= rootEnd) return true;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    return !match || !ROOT_KEYS.has(match[1]);
  });
}

function saveInstallState(paths, original, existed) {
  if (fs.existsSync(paths.codexState)) return;
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.codexState, `${JSON.stringify({
    config_existed: existed,
    original_base64: original.toString("base64"),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.codexState, 0o600);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function readHistoryProviderState(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.historyProviderState, "utf8"));
    return {
      version: 2,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
    };
  } catch {
    return { version: 2, rows: [], files: [] };
  }
}

function candidateStateDatabases(paths) {
  return [...new Set([paths.codexStateDb, paths.codexLegacyStateDb].filter(Boolean))]
    .filter((file) => fs.existsSync(file));
}

function openStateDatabase(file) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, { timeout: 250 });
}

function isDatabaseBusy(error) {
  return error?.code === "ERR_SQLITE_ERROR" && /database is (?:locked|busy)/i.test(error.message);
}

function isFileBusy(error) {
  return ["EBUSY", "EACCES", "EPERM"].includes(error?.code);
}

function listJsonlFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(target);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [target] : [];
  });
}

function writeFileAtomicPreservingMetadata(file, content) {
  const stat = fs.statSync(file);
  const mode = stat.mode & 0o777;
  const temporary = `${file}.9codex-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, content, { mode });
  try {
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (process.platform !== "win32" || !isFileBusy(error)) throw error;
      const backup = `${file}.9codex-backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.renameSync(file, backup);
      try {
        fs.renameSync(temporary, file);
      } catch (replacementError) {
        fs.renameSync(backup, file);
        throw replacementError;
      }
      fs.unlinkSync(backup);
    }
    fs.utimesSync(file, stat.atime, stat.mtime);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function reboundModel(model) {
  if (typeof model !== "string" || model.startsWith("9codex/")) return model;
  const separator = model.indexOf("/");
  return separator === -1 || separator === model.length - 1
    ? model
    : publicModel(model.slice(separator + 1));
}

function rebindRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") return 0;
  let changed = 0;
  if (
    Object.hasOwn(runtime, "model_provider")
    && runtime.model_provider !== "9codex"
  ) {
    runtime.model_provider = "9codex";
    changed += 1;
  }
  if (Object.hasOwn(runtime, "model")) {
    const model = reboundModel(runtime.model);
    if (model !== runtime.model) {
      runtime.model = model;
      changed += 1;
    }
  }
  const collaborationSettings = runtime.collaboration_mode?.settings;
  if (collaborationSettings && typeof collaborationSettings === "object") {
    changed += rebindRuntime(collaborationSettings);
  }
  return changed;
}

function rebindRolloutEvent(event) {
  if (!event || typeof event !== "object") return 0;
  if (event.type === "session_meta" || event.type === "turn_context") {
    return rebindRuntime(event.payload);
  }
  if (event.type === "event_msg") {
    return rebindRuntime(event.payload?.thread_settings);
  }
  return 0;
}

function encodeLine(line) {
  return Buffer.from(line).toString("base64");
}

function decodeLine(line) {
  return Buffer.from(line, "base64").toString("utf8");
}

function collectRolloutChanges(content) {
  const lines = content.split("\n");
  const changes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const before = lines[index];
    if (before.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(before);
    } catch {
      continue;
    }
    if (rebindRolloutEvent(event) === 0) continue;
    const after = JSON.stringify(event);
    lines[index] = after;
    changes.push({
      line: index,
      before_base64: encodeLine(before),
      after_base64: encodeLine(after),
    });
  }
  return { changes, content: lines.join("\n") };
}

function upgradeFileRecord(record, currentContent) {
  if (Array.isArray(record.changes)) return;
  const lines = currentContent.split("\n");
  record.changes = [];
  if (typeof record.first_line_base64 === "string" && lines.length > 0) {
    record.changes.push({
      line: 0,
      before_base64: record.first_line_base64,
      after_base64: encodeLine(lines[0]),
    });
  }
  delete record.first_line_base64;
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function databaseRowRecord(state, databasePath, row, before, after) {
  let record = state.rows.find((item) => item.database === databasePath && item.id === row.id);
  if (!record) {
    record = { database: databasePath, id: row.id, before, after };
    state.rows.push(record);
    return;
  }
  if (!record.before) {
    record.before = { model_provider: record.provider };
    record.after = { model_provider: "9codex" };
    delete record.provider;
  }
  for (const [key, value] of Object.entries(before)) {
    if (!Object.hasOwn(record.before, key)) record.before[key] = value;
  }
  Object.assign(record.after, after);
}

export function migrateCodexHistoryProviders(paths) {
  const state = readHistoryProviderState(paths);
  const recordedFiles = new Map(state.files.map((file) => [file.file, file]));
  let migrated = 0;
  let databases = 0;
  let files = 0;
  let busy = 0;

  const rolloutChanges = [];
  for (const file of [
    ...listJsonlFiles(path.join(paths.codexHome, "sessions")),
    ...listJsonlFiles(path.join(paths.codexHome, "archived_sessions")),
  ]) {
    const current = fs.readFileSync(file, "utf8");
    const rebound = collectRolloutChanges(current);
    if (rebound.changes.length === 0) continue;
    let record = recordedFiles.get(file);
    if (!record) {
      record = { file, changes: [] };
      state.files.push(record);
      recordedFiles.set(file, record);
    }
    upgradeFileRecord(record, current);
    const recordedChanges = new Set(record.changes.map(
      (change) => `${change.line}\0${change.before_base64}\0${change.after_base64}`,
    ));
    record.changes.push(...rebound.changes.filter((change) => {
      const key = `${change.line}\0${change.before_base64}\0${change.after_base64}`;
      if (recordedChanges.has(key)) return false;
      recordedChanges.add(key);
      return true;
    }));
    rolloutChanges.push({ file, content: rebound.content });
  }
  if (rolloutChanges.length > 0) {
    writeJsonAtomic(paths.historyProviderState, state);
    for (const change of rolloutChanges) {
      try {
        writeFileAtomicPreservingMetadata(change.file, change.content);
        files += 1;
      } catch (error) {
        if (!isFileBusy(error)) throw error;
        busy += 1;
      }
    }
  }

  for (const databasePath of candidateStateDatabases(paths)) {
    let database;
    try {
      database = openStateDatabase(databasePath);
      const hasThreads = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
      ).get();
      if (!hasThreads) continue;
      databases += 1;
      const columns = tableColumns(database, "threads");
      const runtimeColumns = ["model_provider", "model"].filter((column) => columns.has(column));
      if (runtimeColumns.length === 0) continue;
      const rows = database.prepare(`SELECT id, ${runtimeColumns.join(", ")} FROM threads`).all();
      const changes = [];
      for (const row of rows) {
        const before = {};
        const after = {};
        if (columns.has("model_provider") && row.model_provider !== "9codex") {
          before.model_provider = row.model_provider;
          after.model_provider = "9codex";
        }
        if (columns.has("model")) {
          const model = reboundModel(row.model);
          if (model !== row.model) {
            before.model = row.model;
            after.model = model;
          }
        }
        if (Object.keys(after).length === 0) continue;
        databaseRowRecord(state, databasePath, row, before, after);
        changes.push({ id: row.id, after });
      }
      if (changes.length === 0) continue;
      writeJsonAtomic(paths.historyProviderState, state);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const change of changes) {
          const fields = Object.keys(change.after);
          const update = database.prepare(
            `UPDATE threads SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`,
          );
          migrated += Number(update.run(...fields.map((field) => change.after[field]), change.id).changes);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
      busy += 1;
    } finally {
      database?.close();
    }
  }

  return { databases, migrated, files, busy };
}

export async function repairCodexHistoryProviders(paths, options = {}) {
  const attempts = options.attempts || 8;
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let totals = { databases: 0, migrated: 0, files: 0, busy: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = migrateCodexHistoryProviders(paths);
    totals = {
      databases: result.databases,
      migrated: totals.migrated + result.migrated,
      files: totals.files + result.files,
      busy: result.busy,
    };
    if (result.busy === 0) return totals;
    if (attempt < attempts - 1) await wait(250 * (attempt + 1));
  }
  throw new Error("Codex history database remained locked during provider migration");
}

export function restoreCodexHistoryProviders(paths) {
  if (!fs.existsSync(paths.historyProviderState)) return { databases: 0, restored: 0, files: 0 };
  const state = readHistoryProviderState(paths);
  const rowsByDatabase = new Map();
  for (const row of state.rows) {
    if (!rowsByDatabase.has(row.database)) rowsByDatabase.set(row.database, []);
    rowsByDatabase.get(row.database).push(row);
  }
  let databases = 0;
  let restored = 0;
  let files = 0;
  const remaining = [];
  const remainingFiles = [];

  for (const [databasePath, rows] of rowsByDatabase) {
    if (!fs.existsSync(databasePath)) {
      remaining.push(...rows);
      continue;
    }
    let database;
    try {
      database = openStateDatabase(databasePath);
      databases += 1;
      const columns = tableColumns(database, "threads");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const before = row.before || { model_provider: row.provider };
          const after = row.after || { model_provider: "9codex" };
          const fields = Object.keys(after).filter((field) => columns.has(field));
          if (fields.length === 0) continue;
          const current = database.prepare(
            `SELECT ${fields.join(", ")} FROM threads WHERE id = ?`,
          ).get(row.id);
          if (!current) continue;
          const restorable = fields.filter((field) => current[field] === after[field]);
          const unresolved = fields.some(
            (field) => current[field] !== after[field] && current[field] !== before[field],
          );
          if (restorable.length > 0) {
            const update = database.prepare(
              `UPDATE threads SET ${restorable.map((field) => `${field} = ?`).join(", ")} WHERE id = ?`,
            );
            restored += Number(
              update.run(...restorable.map((field) => before[field]), row.id).changes,
            );
          }
          if (unresolved) remaining.push(row);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
      remaining.push(...rows);
    } finally {
      database?.close();
    }
  }

  for (const record of state.files) {
    if (!fs.existsSync(record.file)) {
      remainingFiles.push(record);
      continue;
    }
    const current = fs.readFileSync(record.file, "utf8");
    upgradeFileRecord(record, current);
    const lines = current.split("\n");
    let changed = false;
    let unresolved = false;
    for (const change of [...record.changes].reverse()) {
      const before = decodeLine(change.before_base64);
      const after = decodeLine(change.after_base64);
      if (lines[change.line] === after) {
        lines[change.line] = before;
        changed = true;
      } else if (lines[change.line] !== before) {
        unresolved = true;
      }
    }
    if (changed) {
      writeFileAtomicPreservingMetadata(record.file, lines.join("\n"));
      files += 1;
    }
    if (unresolved) remainingFiles.push(record);
  }

  if (remaining.length > 0 || remainingFiles.length > 0) {
    writeJsonAtomic(paths.historyProviderState, { version: 2, rows: remaining, files: remainingFiles });
  }
  else fs.unlinkSync(paths.historyProviderState);
  return { databases, restored, files };
}

export function injectCodexConfig(paths, config, options = {}) {
  if (config.codex?.inject_config === false) return false;
  const existed = fs.existsSync(paths.codexConfig);
  const original = existed ? fs.readFileSync(paths.codexConfig) : Buffer.alloc(0);
  saveInstallState(paths, original, existed);

  const current = original.toString("utf8");
  let lines = stripManagedBlocks(current.split(/\r?\n/));
  lines = stripOwnedRootKeys(lines);
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  const tableLines = firstTable === -1 ? [] : lines.slice(firstTable);
  while (rootLines.length > 0 && rootLines.at(-1) === "") rootLines.pop();
  while (tableLines.length > 0 && tableLines[0] === "") tableLines.shift();
  const bridgeUrl = `http://127.0.0.1:${config.local.port}/v1`;
  const rootBlock = [
    MARKERS.rootStart,
    `model = ${tomlString(publicModel(config.upstream.default_model))}`,
    `model_provider = "9codex"`,
    `model_catalog_json = ${tomlString(paths.catalog)}`,
    MARKERS.rootEnd,
  ];
  const providerBlock = [
    MARKERS.providerStart,
    "[model_providers.9codex]",
    'name = "9codex"',
    `base_url = ${tomlString(bridgeUrl)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    `experimental_bearer_token = ${tomlString(config.local.token)}`,
    'http_headers = { "x-openai-actor-authorization" = "9codex-local" }',
    MARKERS.providerEnd,
  ];
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || process.argv[1];
  const mcpBlock = [
    MARKERS.mcpStart,
    "[mcp_servers.9codex]",
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(cliPath)}, "mcp"]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 180",
    'default_tools_approval_mode = "approve"',
    MARKERS.mcpEnd,
  ];
  const rendered = [
    ...rootBlock,
    ...(rootLines.length > 0 ? ["", ...rootLines] : []),
    "",
    ...providerBlock,
    "",
    ...mcpBlock,
    ...(tableLines.length > 0 ? ["", ...tableLines] : []),
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
  fs.writeFileSync(paths.codexConfig, rendered);
  migrateCodexHistoryProviders(paths);
  return true;
}

export function restoreCodexConfig(paths) {
  if (!fs.existsSync(paths.codexState)) return false;
  const state = JSON.parse(fs.readFileSync(paths.codexState, "utf8"));
  if (state.config_existed) {
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(paths.codexConfig, Buffer.from(state.original_base64, "base64"));
  } else if (fs.existsSync(paths.codexConfig)) {
    fs.unlinkSync(paths.codexConfig);
  }
  fs.unlinkSync(paths.codexState);
  return true;
}
