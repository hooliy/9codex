import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildCatalog } from "./catalog.mjs";
import { validateConfig } from "./config.mjs";
import { PRODUCT_CONTEXT_WINDOW, refreshUpstreamModels } from "./models.mjs";

const TRANSACTION_PREFIX = ".model-state-tx-";
const LOCK_FILE = "model-state.lock";

function catalogPayload(built) {
  return { models: built.models };
}

function modelMapPayload(built) {
  return {
    namespace: "9codex",
    public_to_upstream: built.map,
    upstream_protocols: built.protocols,
    forced_service_tiers: built.forcedServiceTiers,
  };
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function transactionDirectories(paths) {
  try {
    return fs.readdirSync(paths.stateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TRANSACTION_PREFIX))
      .map((entry) => path.join(paths.stateDir, entry.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function restoreTransaction(transactionDir) {
  const metadataFile = path.join(transactionDir, "transaction.json");
  if (!fs.existsSync(metadataFile)) {
    fs.rmSync(transactionDir, { recursive: true, force: true });
    return;
  }
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (metadata.phase !== "committed") {
    for (const entry of [...metadata.targets].reverse()) {
      if (entry.existed) {
        writeFileAtomic(entry.target, fs.readFileSync(path.join(transactionDir, entry.backup)));
      } else {
        try {
          fs.rmSync(entry.target, { force: true });
        } catch {}
      }
    }
  }
  fs.rmSync(transactionDir, { recursive: true, force: true });
}

export function recoverModelState(paths) {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(paths.stateDir, LOCK_FILE);
  if (fs.existsSync(lockFile)) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    } catch {
      lock = null;
    }
    if (processIsAlive(lock?.pid)) {
      throw new Error(`Model state update in progress by PID ${lock.pid}`);
    }
    fs.rmSync(lockFile, { force: true });
  }
  for (const transactionDir of transactionDirectories(paths)) restoreTransaction(transactionDir);
}

function acquireLock(paths, transactionDir) {
  const lockFile = path.join(paths.stateDir, LOCK_FILE);
  const payload = jsonBytes({ pid: process.pid, transaction_dir: transactionDir });
  try {
    fs.writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    recoverModelState(paths);
    fs.writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
  }
  return lockFile;
}

export function validateAuthoritativeModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("No usable model metadata available");
  }
  const seen = new Set();
  return models.map((row) => {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) throw new Error("Invalid model id: expected a non-empty string");
    if (seen.has(id)) throw new Error(`Duplicate model id "${id}"`);
    seen.add(id);
    const contextWindow = Object.hasOwn(row, "context_window")
      ? row.context_window
      : PRODUCT_CONTEXT_WINDOW;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error(`Invalid context_window for model "${id}": expected a positive integer`);
    }
    if (
      row.max_output_tokens !== undefined
      && (!Number.isSafeInteger(row.max_output_tokens) || row.max_output_tokens <= 0)
    ) {
      throw new Error(`Invalid max_output_tokens for model "${id}": expected a positive integer`);
    }
    return structuredClone({ ...row, id, context_window: contextWindow });
  });
}

function convergeSelection(config) {
  const available = config.models.available.filter((row) => row.enabled !== false);
  const ids = new Set(available.map((row) => row.id));
  if (Array.isArray(config.models.enabled_ids)) {
    const retained = [...new Set(config.models.enabled_ids)].filter((id) => ids.has(id));
    config.models.enabled_ids = retained.length > 0 ? retained : null;
  }
  const enabled = config.models.enabled_ids || [...ids];
  if (enabled.length > 0 && !enabled.includes(config.upstream.default_model)) {
    config.upstream.default_model = enabled[0];
  }
  return config;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Model state ${label} is unavailable: ${error.message}`);
  }
}

function loadPreparedState(paths, { recover = true } = {}) {
  if (recover) recoverModelState(paths);
  const persistedConfig = readJson(paths.config, "config");
  validateConfig(persistedConfig);
  const built = buildCatalog(persistedConfig);
  const catalog = readJson(paths.catalog, "catalog");
  if (!isDeepStrictEqual(catalog, catalogPayload(built))) {
    throw new Error("Model state catalog is inconsistent with config");
  }
  const modelMap = readJson(paths.modelMap, "model map");
  if (!isDeepStrictEqual(modelMap, modelMapPayload(built))) {
    throw new Error("Model state model map is inconsistent with config");
  }
  return { config: persistedConfig, catalog, modelMap, built };
}

function validatePreparedState(paths, config, options = {}) {
  const state = loadPreparedState(paths, options);
  if (!isDeepStrictEqual(state.config, config)) {
    throw new Error("Model state config is inconsistent with active config");
  }
  return state.built;
}

export function loadValidatedModelState(paths) {
  return loadPreparedState(paths);
}

export function validateModelState(paths, config) {
  validatePreparedState(paths, config);
  return true;
}

function commitModelState(paths, config, built) {
  recoverModelState(paths);
  const transactionDir = path.join(
    paths.stateDir,
    `${TRANSACTION_PREFIX}${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  const lockFile = acquireLock(paths, transactionDir);
  try {
    fs.mkdirSync(transactionDir, { mode: 0o700 });
    const values = [
      ["catalog", paths.catalog, catalogPayload(built)],
      ["model-map", paths.modelMap, modelMapPayload(built)],
      ["config", paths.config, config],
    ];
    const targets = values.map(([name, target], index) => {
      const existed = fs.existsSync(target);
      const backup = `backup-${index}`;
      if (existed) fs.copyFileSync(target, path.join(transactionDir, backup));
      return { name, target, existed, backup };
    });
    const metadataFile = path.join(transactionDir, "transaction.json");
    const writeMetadata = (phase) => writeFileAtomic(metadataFile, jsonBytes({ phase, targets }));
    for (const [name, , value] of values) {
      fs.writeFileSync(path.join(transactionDir, `${name}.json`), jsonBytes(value), { mode: 0o600 });
    }
    writeMetadata("prepared");
    for (const [name, target] of values) {
      const parent = path.dirname(target);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(transactionDir, `${name}.json`), target);
      fs.chmodSync(target, 0o600);
    }
    validatePreparedState(paths, config, { recover: false });
    writeMetadata("committed");
    try {
      fs.rmSync(transactionDir, { recursive: true, force: true });
    } catch {}
  } catch (error) {
    try {
      if (fs.existsSync(transactionDir)) restoreTransaction(transactionDir);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Model state commit and rollback failed");
    }
    throw error;
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

export async function reconcileModelState(paths, currentConfig, options = {}) {
  const candidate = structuredClone(options.candidateConfig || currentConfig);
  const priorSource = currentConfig.models?.source_base_url;
  const authoritative = options.authoritativeModels === undefined
    ? await refreshUpstreamModels(candidate, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      })
    : options.authoritativeModels;
  candidate.models.available = validateAuthoritativeModels(authoritative);
  candidate.models.source_base_url = candidate.upstream.base_url;
  if (priorSource !== candidate.upstream.base_url) candidate.models.enabled_ids = null;
  convergeSelection(candidate);
  const prepared = options.prepareCandidate
    ? await options.prepareCandidate(structuredClone(candidate))
    : candidate;
  convergeSelection(prepared);
  validateConfig(prepared);
  const built = buildCatalog(prepared);
  commitModelState(paths, prepared, built);
  return { config: prepared, built };
}
