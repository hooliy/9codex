import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTO_UPDATE_CHECK_MS,
  AUTO_UPDATE_RETRY_MS,
  getGatewayActivity,
  launchPendingUpdate,
  ownsUpdateLock,
  runAutomaticUpdateCycle,
  startAutomaticUpdates,
  waitForGatewayIdle,
} from "../lib/auto-update.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-auto-update-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

const config = {
  updates: {
    enabled: true,
    auto_install: true,
    channel: "stable",
    npm_registry: "https://registry.npmjs.org",
  },
};

test("queues a newer npm version but never launches it while gateway requests are active", async () => {
  const paths = fixture();
  let launches = 0;
  const result = await runAutomaticUpdateCycle(paths, {
    currentVersion: "1.1.12",
    loadConfig: () => config,
    resolveLatestVersion: async () => "1.1.13",
    getActivity: async () => ({ state: "busy" }),
    launchUpdate: async () => { launches += 1; },
    checkLatest: true,
  });

  assert.equal(result.status, "queued");
  assert.equal(launches, 0);
  assert.equal(JSON.parse(fs.readFileSync(paths.pendingUpdate)).version, "1.1.13");
});

test("launches one hidden detached worker after the gateway becomes idle", async () => {
  const paths = fixture();
  fs.writeFileSync(paths.pendingUpdate, JSON.stringify({
    version: "1.1.13",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }));
  const calls = [];

  const result = await runAutomaticUpdateCycle(paths, {
    currentVersion: "1.1.12",
    loadConfig: () => config,
    getActivity: async () => ({ state: "idle" }),
    launchUpdate: async (pending) => { calls.push(pending.version); return true; },
    checkLatest: false,
  });

  assert.equal(result.status, "launched");
  assert.deepEqual(calls, ["1.1.13"]);
});

test("unknown gateway state keeps the update queued", async () => {
  const paths = fixture();
  fs.writeFileSync(paths.pendingUpdate, JSON.stringify({
    version: "1.1.13",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }));

  const result = await runAutomaticUpdateCycle(paths, {
    currentVersion: "1.1.12",
    loadConfig: () => config,
    getActivity: async () => ({ state: "unknown" }),
    launchUpdate: async () => assert.fail("must not launch"),
    checkLatest: false,
  });

  assert.equal(result.status, "queued");
});

test("worker launch owns an atomic lock and hides Windows consoles", async () => {
  const paths = fixture();
  const calls = [];
  const child = { pid: 77, unref() { calls.push("unref"); } };

  const launched = launchPendingUpdate(paths, {
    version: "1.1.13",
    channel: "stable",
    registry: "https://registry.npmjs.org",
  }, {
    nodePath: "node.exe",
    cliPath: "C:\\nine\\9codex.mjs",
    randomUUID: () => "token",
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return child;
    },
  });

  assert.equal(launched, true);
  assert.deepEqual(calls[0], {
    file: "node.exe",
    args: ["C:\\nine\\9codex.mjs", "update-worker", "1.1.13", "token"],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  });
  assert.equal(calls[1], "unref");
  assert.equal(JSON.parse(fs.readFileSync(paths.updateLock)).pid, 77);
  assert.equal(ownsUpdateLock(paths, "token", "1.1.13"), true);
  assert.equal(ownsUpdateLock(paths, "wrong", "1.1.13"), false);
  assert.equal(launchPendingUpdate(paths, { version: "1.1.13" }, {
    processAlive: () => true,
    spawn: () => assert.fail("must not spawn twice"),
  }), false);
});

test("a dead update worker lock is recovered automatically", () => {
  const paths = fixture();
  fs.writeFileSync(paths.updateLock, JSON.stringify({
    token: "dead",
    pid: 123,
    version: "1.1.13",
  }));

  const launched = launchPendingUpdate(paths, { version: "1.1.13" }, {
    nodePath: "node",
    cliPath: "/nine/9codex.mjs",
    randomUUID: () => "fresh",
    processAlive: () => false,
    spawn: () => ({ pid: 456, unref() {} }),
  });

  assert.equal(launched, true);
  assert.equal(JSON.parse(fs.readFileSync(paths.updateLock)).pid, 456);
});

test("reads active request count from the daemon health endpoint", async () => {
  const activity = await getGatewayActivity(fixture(), {
    loadConfig: () => ({ local: { host: "127.0.0.1", port: 10101 } }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ready: true, active_requests: 2 }),
    }),
  });

  assert.deepEqual(activity, { state: "busy", active_requests: 2 });
});

test("update worker waits through busy and unknown states until the gateway is idle", async () => {
  const states = ["busy", "unknown", "idle"];
  let waits = 0;

  const activity = await waitForGatewayIdle(fixture(), {
    getActivity: async () => ({ state: states.shift() }),
    wait: async (milliseconds) => {
      assert.equal(milliseconds, AUTO_UPDATE_RETRY_MS);
      waits += 1;
    },
  });

  assert.equal(activity.state, "idle");
  assert.equal(waits, 2);
});

test("scheduler checks npm every five minutes and queued work every minute", () => {
  const intervals = [];
  const scheduler = startAutomaticUpdates(fixture(), {
    currentVersion: "1.1.12",
    setInterval: (callback, milliseconds) => {
      intervals.push(milliseconds);
      return { unref() {} };
    },
    clearInterval() {},
    runCycle: async () => ({ status: "idle" }),
  });

  scheduler.close();
  assert.deepEqual(intervals.sort((a, b) => a - b), [
    AUTO_UPDATE_RETRY_MS,
    AUTO_UPDATE_CHECK_MS,
  ]);
  assert.equal(AUTO_UPDATE_CHECK_MS, 5 * 60 * 1000);
  assert.equal(AUTO_UPDATE_RETRY_MS, 60 * 1000);
});
