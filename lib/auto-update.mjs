import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getCodexActivity } from "./codex-activity.mjs";
import { compareVersions, resolveLatestVersion } from "./updater.mjs";

export const AUTO_UPDATE_CHECK_MS = 5 * 60 * 1000;
export const AUTO_UPDATE_RETRY_MS = 60 * 1000;

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readPendingUpdate(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.pendingUpdate, "utf8"));
  } catch {
    return null;
  }
}

function processAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockUpdate(paths, value, options = {}) {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(paths.updateLock, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(paths.updateLock, "utf8"));
      } catch {}
      if (
        attempt > 0
        || !Number.isInteger(owner?.pid)
        || (options.processAlive || processAliveDefault)(owner.pid)
      ) return false;
      try { fs.unlinkSync(paths.updateLock); } catch { return false; }
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }
  return false;
}

export function releaseUpdateLock(paths, token) {
  try {
    const lock = JSON.parse(fs.readFileSync(paths.updateLock, "utf8"));
    if (lock.token === token) fs.unlinkSync(paths.updateLock);
  } catch {}
}

export function ownsUpdateLock(paths, token, version) {
  try {
    const lock = JSON.parse(fs.readFileSync(paths.updateLock, "utf8"));
    return lock.token === token && lock.version === version;
  } catch {
    return false;
  }
}

export async function waitForCodexIdle(paths, options = {}) {
  const wait = options.wait || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (true) {
    const activity = await (options.getActivity || getCodexActivity)(paths);
    if (activity.state === "idle") return activity;
    await wait(AUTO_UPDATE_RETRY_MS);
  }
}

export function launchPendingUpdate(paths, pending, options = {}) {
  const token = (options.randomUUID || crypto.randomUUID)();
  if (!lockUpdate(paths, {
    token,
    pid: process.pid,
    version: pending.version,
    created_at: new Date().toISOString(),
  }, options)) return false;
  try {
    const child = (options.spawn || spawn)(
      options.nodePath || process.execPath,
      [options.cliPath, "update-worker", pending.version, token],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    atomicWrite(paths.updateLock, {
      token,
      pid: child.pid,
      version: pending.version,
      created_at: new Date().toISOString(),
    });
    child.unref();
    return true;
  } catch (error) {
    releaseUpdateLock(paths, token);
    throw error;
  }
}

export async function runAutomaticUpdateCycle(paths, options = {}) {
  const config = (options.loadConfig || loadConfig)(paths);
  if (config.updates?.enabled === false || config.updates?.auto_install === false) {
    return { status: "disabled" };
  }
  if (options.checkLatest !== false) {
    const latest = await (options.resolveLatestVersion || resolveLatestVersion)(
      config.updates,
    );
    if (compareVersions(latest, options.currentVersion) > 0) {
      atomicWrite(paths.pendingUpdate, {
        version: latest,
        channel: config.updates.channel,
        registry: config.updates.npm_registry,
      });
    }
  }
  const pending = readPendingUpdate(paths);
  if (!pending || compareVersions(pending.version, options.currentVersion) <= 0) {
    if (pending) {
      try { fs.unlinkSync(paths.pendingUpdate); } catch {}
    }
    return { status: "idle" };
  }
  const activity = await (options.getActivity || getCodexActivity)(paths);
  if (activity.state !== "idle") {
    return { status: "queued", activity: activity.state, version: pending.version };
  }
  const launched = await (options.launchUpdate || ((value) =>
    launchPendingUpdate(paths, value, options)))(pending);
  return {
    status: launched ? "launched" : "locked",
    version: pending.version,
  };
}

export function startAutomaticUpdates(paths, options = {}) {
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const runCycle = options.runCycle || ((cycleOptions) =>
    runAutomaticUpdateCycle(paths, { ...options, ...cycleOptions }));
  let running = false;
  const run = async (checkLatest) => {
    if (running) return;
    running = true;
    try {
      await runCycle({ checkLatest });
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const checks = setTimer(() => void run(true), AUTO_UPDATE_CHECK_MS);
  const queued = setTimer(() => void run(false), AUTO_UPDATE_RETRY_MS);
  checks.unref?.();
  queued.unref?.();
  void run(true);
  return {
    close() {
      clearTimer(checks);
      clearTimer(queued);
    },
  };
}
