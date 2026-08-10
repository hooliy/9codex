import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listCodexProcesses } from "./platform.mjs";

const LIFECYCLE_PATTERN = /"type":"task_(?:started|complete)"/;

function readSessionDefault(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function listThreadsDefault(startedAtMs, home = os.homedir()) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = path.join(home, ".codex", "state_5.sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, rollout_path
      FROM threads
      WHERE updated_at_ms >= ?
      ORDER BY updated_at_ms DESC
    `).all(startedAtMs);
  } finally {
    db.close();
  }
}

export function readLastTaskLifecycle(file, options = {}) {
  const chunkSize = options.chunkSize || 64 * 1024;
  const descriptor = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(descriptor).size;
    let suffix = "";
    while (position > 0) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      fs.readSync(descriptor, buffer, 0, size, position);
      const text = buffer.toString("utf8") + suffix;
      const lines = text.split("\n");
      suffix = lines.shift() || "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!LIFECYCLE_PATTERN.test(line)) continue;
        try {
          const event = JSON.parse(line);
          const type = event?.type === "event_msg" ? event.payload?.type : null;
          if (type === "task_started" || type === "task_complete") {
            return { type, timestamp: event.timestamp };
          }
        } catch {}
      }
    }
    if (LIFECYCLE_PATTERN.test(suffix)) {
      const event = JSON.parse(suffix);
      const type = event?.type === "event_msg" ? event.payload?.type : null;
      if (type === "task_started" || type === "task_complete") {
        return { type, timestamp: event.timestamp };
      }
    }
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function getCodexActivity(paths, options = {}) {
  let processes;
  try {
    processes = await (options.listProcesses || listCodexProcesses)();
  } catch {
    return { state: "unknown", active_threads: [] };
  }
  if (processes.length === 0) return { state: "idle", active_threads: [] };

  let session;
  try {
    session = await (options.loadSession || readSessionDefault)(paths.desktopSession);
  } catch {
    return { state: "unknown", active_threads: [] };
  }
  const processIds = Array.isArray(session?.process_ids)
    ? session.process_ids.filter(Number.isInteger)
    : [];
  const managed = processIds.some((pid) => processes.some((process) => process.pid === pid));
  const startedAtMs = Date.parse(session?.started_at);
  if (!managed || !Number.isFinite(startedAtMs)) {
    return { state: "unknown", active_threads: [] };
  }

  let threads;
  try {
    threads = await (options.listThreads || listThreadsDefault)(
      startedAtMs,
      paths.home,
    );
  } catch {
    return { state: "unknown", active_threads: [] };
  }

  const activeThreads = [];
  for (const thread of threads) {
    let lifecycle;
    try {
      lifecycle = await (options.readLifecycle || readLastTaskLifecycle)(thread.rollout_path);
    } catch {
      return { state: "unknown", active_threads: [] };
    }
    if (lifecycle && !Number.isFinite(Date.parse(lifecycle.timestamp))) {
      return { state: "unknown", active_threads: [] };
    }
    if (
      lifecycle?.type === "task_started"
      && Date.parse(lifecycle.timestamp) >= startedAtMs
    ) {
      activeThreads.push(thread.id);
    }
  }
  return activeThreads.length > 0
    ? { state: "busy", active_threads: activeThreads }
    : { state: "idle", active_threads: [] };
}
