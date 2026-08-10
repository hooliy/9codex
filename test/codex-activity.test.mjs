import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  getCodexActivity,
  readLastTaskLifecycle,
} from "../lib/codex-activity.mjs";

const paths = {
  desktopSession: "/tmp/desktop-session.json",
};

test("importing Codex activity support does not load experimental SQLite", () => {
  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(new URL("../lib/codex-activity.mjs", import.meta.url).href)})`,
  ], { encoding: "utf8" });

  assert.equal(imported.status, 0);
  assert.doesNotMatch(imported.stderr, /ExperimentalWarning|SQLite is an experimental feature/);
});

function context(lifecycles) {
  return {
    listProcesses: async () => [{ pid: 42, name: "ChatGPT" }],
    loadSession: () => ({
      process_ids: [42],
      started_at: "2026-08-06T08:00:00.000Z",
      updated_at: "2026-08-06T08:00:00.000Z",
    }),
    listThreads: () => lifecycles.map((lifecycle, index) => ({
      id: `thread-${index}`,
      rollout_path: `/tmp/thread-${index}.jsonl`,
    })),
    readLifecycle: (file) => lifecycles[Number(file.match(/\d+/)[0])],
  };
}

test("reports busy when any managed Codex task is still running", async () => {
  const result = await getCodexActivity(paths, context([
    { type: "task_complete", timestamp: "2026-08-06T08:01:00.000Z" },
    { type: "task_started", timestamp: "2026-08-06T08:02:00.000Z" },
  ]));

  assert.equal(result.state, "busy");
  assert.deepEqual(result.active_threads, ["thread-1"]);
});

test("reports idle when all task histories are complete", async () => {
  const result = await getCodexActivity(paths, context([
    { type: "task_complete", timestamp: "2026-08-06T08:01:00.000Z" },
  ]));

  assert.deepEqual(result, { state: "idle", active_threads: [] });
});

test("ignores unfinished tasks from before the current Codex process", async () => {
  const result = await getCodexActivity(paths, context([
    { type: "task_started", timestamp: "2026-08-06T07:59:59.000Z" },
  ]));

  assert.deepEqual(result, { state: "idle", active_threads: [] });
});

test("fails closed when Codex activity cannot be verified", async () => {
  const result = await getCodexActivity(paths, {
    ...context([]),
    listThreads: async () => { throw new Error("state unavailable"); },
  });

  assert.equal(result.state, "unknown");
});

test("a stopped Codex application is idle", async () => {
  const result = await getCodexActivity(paths, {
    listProcesses: async () => [],
  });

  assert.deepEqual(result, { state: "idle", active_threads: [] });
});

test("an unmanaged Codex process is never considered safe to restart", async () => {
  const result = await getCodexActivity(paths, {
    ...context([]),
    listProcesses: async () => [{ pid: 99, name: "ChatGPT" }],
  });

  assert.equal(result.state, "unknown");
});

test("reverse lifecycle scan tolerates large and half-written JSONL records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-activity-test-"));
  const rollout = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(rollout, [
    JSON.stringify({
      timestamp: "2026-08-06T08:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
        detail: "中".repeat(200_000),
      },
    }),
    "{\"timestamp\":\"2026-08-06T08:02:00.000Z\",\"type\":\"event_msg\"",
  ].join("\n"));

  assert.deepEqual(readLastTaskLifecycle(rollout), {
    type: "task_started",
    timestamp: "2026-08-06T08:01:00.000Z",
  });
});
