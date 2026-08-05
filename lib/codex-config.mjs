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
const LEGACY_HISTORY_PROVIDERS = ["openai", "codex_bridge", "9router", "spanai"];

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
      version: 1,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
    };
  } catch {
    return { version: 1, rows: [], files: [] };
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

function readFirstLine(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const chunks = [];
    let offset = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      const value = chunk.subarray(0, bytesRead);
      const boundary = value.indexOf(0x0a);
      chunks.push(boundary === -1 ? value : value.subarray(0, boundary));
      if (boundary !== -1 || bytesRead < chunk.length) break;
      offset += bytesRead;
    }
    return { firstLine: Buffer.concat(chunks).toString("utf8") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function replaceFirstLineAtomic(file, current, firstLine) {
  const stat = fs.statSync(file);
  const before = Buffer.from(current.firstLine);
  const after = Buffer.from(firstLine);
  if (before.length === after.length) {
    const descriptor = fs.openSync(file, "r+");
    try {
      fs.writeSync(descriptor, after, 0, after.length, 0);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.utimesSync(file, stat.atime, stat.mtime);
    return;
  }
  const content = fs.readFileSync(file);
  const boundary = content.indexOf(0x0a);
  const suffix = boundary === -1 ? Buffer.alloc(0) : content.subarray(boundary);
  const replacement = Buffer.concat([Buffer.from(firstLine), suffix]);
  const mode = stat.mode & 0o777;
  const temporary = `${file}.9codex-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, replacement, { mode });
  fs.renameSync(temporary, file);
  fs.utimesSync(file, stat.atime, stat.mtime);
}

function rolloutProvider(firstLine) {
  try {
    const event = JSON.parse(firstLine);
    return event?.type === "session_meta" ? event.payload?.model_provider : null;
  } catch {
    return null;
  }
}

export function migrateCodexHistoryProviders(paths) {
  const state = readHistoryProviderState(paths);
  const recorded = new Set(state.rows.map((row) => `${row.database}\0${row.id}`));
  const recordedFiles = new Map(state.files.map((file) => [file.file, file]));
  let migrated = 0;
  let databases = 0;
  let files = 0;

  const rolloutChanges = [];
  for (const file of [
    ...listJsonlFiles(path.join(paths.codexHome, "sessions")),
    ...listJsonlFiles(path.join(paths.codexHome, "archived_sessions")),
  ]) {
    const current = readFirstLine(file);
    const provider = rolloutProvider(current.firstLine);
    if (!LEGACY_HISTORY_PROVIDERS.includes(provider)) continue;
    if (!recordedFiles.has(file)) {
      const record = {
        file,
        first_line_base64: Buffer.from(current.firstLine).toString("base64"),
      };
      state.files.push(record);
      recordedFiles.set(file, record);
    }
    const firstLine = current.firstLine.replace(
      /(\"model_provider\"\s*:\s*\")[^\"]+(\")/,
      (_match, before, after) => `${before}9codex${after}`,
    );
    if (firstLine !== current.firstLine) rolloutChanges.push({ file, current, firstLine });
  }
  if (rolloutChanges.length > 0) {
    writeJsonAtomic(paths.historyProviderState, state);
    for (const change of rolloutChanges) {
      replaceFirstLineAtomic(change.file, change.current, change.firstLine);
      files += 1;
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
      const placeholders = LEGACY_HISTORY_PROVIDERS.map(() => "?").join(", ");
      const rows = database.prepare(
        `SELECT id, model_provider FROM threads WHERE model_provider IN (${placeholders})`,
      ).all(...LEGACY_HISTORY_PROVIDERS);
      const additions = rows
        .filter((row) => !recorded.has(`${databasePath}\0${row.id}`))
        .map((row) => ({ database: databasePath, id: row.id, provider: row.model_provider }));
      if (additions.length > 0) {
        state.rows.push(...additions);
        for (const row of additions) recorded.add(`${row.database}\0${row.id}`);
        writeJsonAtomic(paths.historyProviderState, state);
      }
      if (rows.length === 0) continue;
      database.exec("BEGIN IMMEDIATE");
      try {
        const update = database.prepare("UPDATE threads SET model_provider = '9codex' WHERE id = ? AND model_provider = ?");
        for (const row of rows) migrated += Number(update.run(row.id, row.model_provider).changes);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
    } finally {
      database?.close();
    }
  }

  return { databases, migrated, files };
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
      database.exec("BEGIN IMMEDIATE");
      try {
        const update = database.prepare(
          "UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = '9codex'",
        );
        for (const row of rows) restored += Number(update.run(row.provider, row.id).changes);
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
    const current = readFirstLine(record.file);
    if (rolloutProvider(current.firstLine) !== "9codex") {
      remainingFiles.push(record);
      continue;
    }
    replaceFirstLineAtomic(
      record.file,
      current,
      Buffer.from(record.first_line_base64, "base64").toString("utf8"),
    );
    files += 1;
  }

  if (remaining.length > 0 || remainingFiles.length > 0) {
    writeJsonAtomic(paths.historyProviderState, { version: 1, rows: remaining, files: remainingFiles });
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
