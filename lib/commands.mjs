import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_COMMANDS = new Set([
  "config.refresh",
  "models.refresh",
  "service.restart",
  "package.update",
  "diagnostics.collect",
]);

export class CommandError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "CommandError";
    this.code = code;
  }
}

function readState(paths) {
  try {
    const state = JSON.parse(fs.readFileSync(paths.commandState, "utf8"));
    return {
      last_sequence: Number(state.last_sequence) || 0,
      processed_ids: Array.isArray(state.processed_ids) ? state.processed_ids : [],
    };
  } catch {
    return { last_sequence: 0, processed_ids: [] };
  }
}

function writeState(paths, state) {
  fs.mkdirSync(path.dirname(paths.commandState), { recursive: true, mode: 0o700 });
  const temp = `${paths.commandState}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, paths.commandState);
}

export function validateCommand(command, state, now = new Date()) {
  if (!command || typeof command !== "object") throw new CommandError("invalid_command");
  if (typeof command.command_id !== "string" || !/^cmd_[A-Za-z0-9_-]+$/.test(command.command_id)) {
    throw new CommandError("invalid_command", "command_id is invalid");
  }
  if (!ALLOWED_COMMANDS.has(command.type)) throw new CommandError("unknown_command");
  if (state.processed_ids.includes(command.command_id)) throw new CommandError("duplicate_command");
  if (!Number.isInteger(command.sequence) || command.sequence !== state.last_sequence + 1) {
    throw new CommandError("out_of_sequence");
  }
  const issuedAt = Date.parse(command.issued_at);
  const expiresAt = Date.parse(command.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > expiresAt) {
    throw new CommandError("invalid_command", "command timestamps are invalid");
  }
  if (now.getTime() > expiresAt) throw new CommandError("expired_command");
  if (issuedAt > now.getTime() + 5 * 60 * 1000) throw new CommandError("future_command");
  if (command.payload !== undefined && (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload))) {
    throw new CommandError("invalid_payload");
  }
  return command;
}

function validatePackagePayload(payload) {
  const keys = Object.keys(payload || {});
  if (
    payload?.package !== "@hooliy/9codex" ||
    typeof payload?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(payload.version) ||
    keys.some((key) => !["package", "version", "registry", "channel"].includes(key))
  ) {
    throw new CommandError("invalid_payload", "package.update payload is invalid");
  }
}

export async function executeCommand(command, context) {
  const state = readState(context.paths);
  validateCommand(command, state, context.now?.() || new Date());
  const nextState = {
    last_sequence: command.sequence,
    processed_ids: [...state.processed_ids, command.command_id].slice(-1000),
  };
  let result;
  switch (command.type) {
    case "service.restart":
      context.deferAfterAck?.(() => context.restartService());
      result = { service_restart_requested: true };
      break;
    case "config.refresh":
    case "models.refresh": {
      const synced = await context.syncConfig();
      if (synced.changed) {
        context.deferAfterAck?.(() => context.restartService());
      }
      result = {
        config_changed: synced.changed,
        config_revision: synced.config.control_plane?.config_revision || null,
        service_restart_requested: synced.changed,
      };
      break;
    }
    case "package.update":
      validatePackagePayload(command.payload);
      context.deferAfterAck?.(() => context.updatePackage(command.payload));
      result = { package_update_requested: true, target_version: command.payload.version };
      break;
    case "diagnostics.collect":
      result = context.collectDiagnostics
        ? await context.collectDiagnostics()
        : { diagnostics: "unavailable" };
      break;
    default:
      throw new CommandError("unknown_command");
  }
  writeState(context.paths, nextState);
  return result;
}
