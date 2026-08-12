import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTaskCenterBridge,
  buildTaskCenterBridgeScript,
  buildTaskCenterPayload,
  desktopDebugPort,
} from "../lib/task-center-bridge.mjs";

test("task center bridge injects one Chinese sidebar entry with redraw recovery", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{ id: "tg_1", title: "Login", status: "executing", progress: 50 }],
    taskboardUrl: "http://127.0.0.1:10102/#token=local",
  });

  assert.match(source, /任务中心/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /ninecodex-task-center-button/);
  assert.match(source, /插件/);
  assert.match(source, /浏览器打开/);
  assert.match(source, /Codex 会话任务/);
  assert.match(source, /window\.__ninecodexTaskCenterBridge/);
  assert.match(source, /--color-background-surface/);
  assert.match(source, /--color-text-foreground/);
  assert.match(source, /--codex-base-accent/);
  assert.match(source, /color-scheme:inherit/);
  assert.doesNotMatch(source, /document\.write|location\.reload/);
});

test("task center bridge escapes task content before embedding it in renderer JavaScript", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{ id: "tg_1", title: "</script><script>alert(1)</script>", status: "blocked" }],
    taskboardUrl: "http://127.0.0.1:10102/",
  });

  assert.doesNotMatch(source, /<\/script>/);
  assert.match(source, /\\u003c\/script>/);
});

test("task center bridge targets only the main renderer and verifies its button", async () => {
  const evaluated = [];
  const result = await applyTaskCenterBridge({
    port: 53111,
    taskGroups: [{ id: "tg_1", status: "executing" }],
    taskboardUrl: "http://127.0.0.1:10102/",
    listTargets: async () => [
      { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay" },
      { id: "worker", type: "service_worker", url: "app://-/worker.js" },
      { id: "main", type: "page", url: "app://-/index.html" },
    ],
    evaluateTarget: async (target, source) => {
      evaluated.push({ target, source });
      return { applied: true, button: true, tasks: 1 };
    },
  });

  assert.deepEqual(evaluated.map(({ target }) => target.id), ["main"]);
  assert.deepEqual(result, { connected: true, verified: true, tasks: 1 });
});

test("task center payload hides empty observed conversations and includes task detail", () => {
  const store = {
    listTaskGroups() {
      return [
        { id: "empty", status: "collecting", demand_count: 0 },
        {
          id: "active",
          title: "Active",
          status: "executing",
          demand_count: 1,
          progress: 25,
          current_stage: "executing",
          running_workers: 1,
          blocker_count: 0,
          updated_at: "2026-08-12T00:00:00.000Z",
        },
      ];
    },
    getTaskGroupSnapshot(id) {
      assert.equal(id, "active");
      return {
        demand_events: [{ id: "de_1" }],
        requirement_revisions: [{ id: "rr_1" }],
        work_items: [{ id: "wi_1" }],
        evidence: [{ id: "ev_1" }],
        acceptances: [{ id: "ac_1" }],
      };
    },
  };

  const payload = buildTaskCenterPayload(store);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, "active");
  assert.equal(payload[0].work_items[0].id, "wi_1");
});

test("desktop bridge reads the saved loopback debugging port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-task-center-"));
  const file = path.join(root, "desktop-session.json");
  fs.writeFileSync(file, JSON.stringify({ debug_port: 53111 }));

  assert.equal(desktopDebugPort(file), 53111);
  assert.equal(desktopDebugPort(path.join(root, "missing.json")), null);
});
