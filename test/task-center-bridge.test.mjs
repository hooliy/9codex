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
  enrichWorkItems,
} from "../lib/task-center-bridge.mjs";

test("task center bridge injects one global task center entry with live worker details", () => {
  const source = buildTaskCenterBridgeScript({
    taskGroups: [{
      id: "tg_1",
      origin_thread_id: "thread-1",
      title: "Login",
      status: "executing",
      progress: 50,
      pending_confirmation: {
        event_key: "thread-1:message-1",
        proposed_requirement: { title: "Login" },
        proposed_work_items: [{ key: "a", title: "API" }],
      },
    }],
    taskboardUrl: "http://127.0.0.1:10102/#token=local",
  });

  assert.match(source, /任务中心/);
  assert.match(source, /全局监督/);
  assert.match(source, /Reviewer\/Integrator 验收/);
  assert.match(source, /setInterval/);
  assert.match(source, /ninecodex-session-tasks-entry/);
  assert.match(source, /ninecodex-session-task-panel/);
  assert.match(source, /侧边聊天/);
  assert.match(source, /data-app-shell-tab-strip-controller/);
  assert.match(source, /ninecodex-task-center-tab/);
  assert.match(source, /data-app-shell-tabs/);
  assert.doesNotMatch(source, /textContent\.trim\(\) === "插件"/);
  assert.doesNotMatch(source, /plugin\.after\(button\)/);
  assert.match(source, /selectedWorkItemId/);
  assert.match(source, /nine-st-metrics/);
  assert.match(source, /nine-st-item-progress/);
  assert.match(source, /实时执行动态/);
  assert.match(source, /会话实时输出/);
  assert.match(source, /工作项执行详情/);
  assert.match(source, /历史尝试/);
  assert.match(source, /Checkpoint/);
  assert.match(source, /删除此工作项/);
  assert.match(source, /清空全部任务/);
  assert.match(source, /在浏览器中打开完整任务板/);
  assert.match(source, /确认并执行/);
  assert.match(source, /state\.actions\.push/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /actionResults/);
  assert.match(source, /openCodexThread/);
  assert.match(source, /existing\.sync/);
  assert.match(source, /window\.__ninecodexTaskCenterBridge/);
  assert.match(source, /--color-background-surface/);
  assert.match(source, /--color-text-foreground/);
  assert.match(source, /--codex-base-accent/);
  assert.match(source, /color-scheme:inherit/);
  assert.doesNotMatch(source, /当前会话任务/);
  assert.doesNotMatch(source, /selectedThreadId/);
  assert.doesNotMatch(source, /origin_thread_id ===/);
  assert.doesNotMatch(source, /rightSidebarFor/);
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

test("task center bridge targets only the main renderer", async () => {
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
      return { applied: true, entry: true, tasks: 1, actions: [{ type: "confirm", taskGroupId: "tg_1" }] };
    },
  });

  assert.deepEqual(evaluated.map(({ target }) => target.id), ["main"]);
  assert.deepEqual(result, {
    connected: true,
    verified: true,
    tasks: 1,
    actions: [{ type: "confirm", taskGroupId: "tg_1" }],
  });
});

test("task center payload hides empty observed conversations and includes task detail", () => {
  const store = {
    listTaskGroups() {
      return [
        { id: "empty", status: "collecting", demand_count: 0 },
        {
          id: "active",
          origin_thread_id: "thread-1",
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
        demand_events: [{
          id: "de_1",
          event_key: "thread-1:message-1",
          result_json: JSON.stringify({
            status: "awaiting_confirmation",
            proposedRequirement: { title: "Login" },
            proposedWorkItems: [{ key: "a", title: "API" }],
          }),
        }],
      };
    },
  };

  const payload = buildTaskCenterPayload(store);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, "global");
  assert.equal(payload[0].work_items[0].id, "wi_1");
  assert.deepEqual(payload[0].pending_confirmations, []);
});

test("task center payload exposes only the active pending confirmation", () => {
  const store = {
    listTaskGroups: () => [{
      id: "waiting",
      origin_thread_id: "thread-1",
      status: "awaiting_confirmation",
      demand_count: 1,
    }],
    getTaskGroupSnapshot: () => ({
      demand_events: [{
        event_key: "thread-1:message-1",
        result_json: JSON.stringify({
          status: "awaiting_confirmation",
          proposedRequirement: { title: "Login" },
          proposedWorkItems: [{ key: "a", title: "API" }],
        }),
      }],
    }),
  };

  const [payload] = buildTaskCenterPayload(store);
  assert.equal(payload.pending_confirmations[0].event_key, "thread-1:message-1");
});

test("task center does not present work from blocked groups as queued or running", () => {
  const store = {
    listTaskGroups: () => [{
      id: "blocked-group",
      status: "blocked",
      demand_count: 1,
      running_workers: 0,
    }],
    getTaskGroupSnapshot: () => ({
      status: "blocked",
      work_items: [
        { id: "ready", title: "Queued forever", status: "ready" },
        { id: "rework", title: "Interrupted rework", status: "rework" },
      ],
    }),
  };

  const [payload] = buildTaskCenterPayload(store);
  assert.equal(payload.counts.pending, 0);
  assert.equal(payload.counts.running, 0);
  assert.equal(payload.counts.failed, 2);
  assert.deepEqual(payload.work_items.map((item) => item.status), ["blocked", "blocked"]);
  assert.match(payload.work_items[0].waiting_reason, /不会自动执行/);
});

test("task center moves paused historical work out of the pending lane", () => {
  const [payload] = buildTaskCenterPayload({
    listTaskGroups: () => [{ id: "paused", status: "paused", demand_count: 1 }],
    getTaskGroupSnapshot: () => ({ work_items: [{ id: "wi_1", status: "ready" }] }),
  });

  assert.equal(payload.counts.pending, 0);
  assert.equal(payload.counts.done, 1);
  assert.equal(payload.work_items[0].status, "paused");
});

test("task center enriches queued work with dependency, owner, reason, progress, and next action", () => {
  const [blocked, ready] = enrichWorkItems({
    work_items: [
      { id: "wi_1", title: "First", status: "blocked", priority: 1, updated_at: "2026-08-12T00:00:00.000Z" },
      { id: "wi_2", title: "Second", status: "ready", priority: 0, updated_at: "2026-08-12T00:00:01.000Z" },
    ],
    work_item_dependencies: [{ work_item_id: "wi_2", depends_on_id: "wi_1" }],
    worker_sessions: [{
      id: "ws_1",
      work_item_id: "wi_1",
      role: "worker",
      codex_thread_id: "internal-thread-1",
      updated_at: "2026-08-12T00:00:02.000Z",
    }],
    runs: [{
      id: "run_1",
      worker_session_id: "ws_1",
      work_item_id: "wi_1",
      status: "failed",
      updated_at: "2026-08-12T00:00:03.000Z",
    }],
    acceptances: [{ id: "ac_1", scope: "work_item", scope_id: "wi_1", result: "failed", created_at: "2026-08-12T00:00:04.000Z" }],
    events: [{
      aggregate_type: "work_item",
      aggregate_id: "wi_1",
      event_type: "work_item.status_changed",
      payload: { reason: "repeated_failure_fingerprint" },
      created_at: "2026-08-12T00:00:05.000Z",
    }],
  });

  assert.match(blocked.owner, /执行 AI/);
  assert.equal(blocked.worker_thread_id, "internal-thread-1");
  assert.equal(blocked.execution_history[0].codex_thread_id, "internal-thread-1");
  assert.equal(blocked.execution_history[0].runs[0].status, "failed");
  assert.equal(blocked.run_status, "failed");
  assert.equal(blocked.acceptance_result, "failed");
  assert.match(blocked.status_reason, /停止自动重试/);
  assert.equal(ready.queue_position, 1);
  assert.deepEqual(ready.unmet_dependencies, ["wi_1"]);
  assert.match(ready.waiting_reason, /等待依赖/);
  assert.match(ready.next_action, /自动调度/);
});

test("desktop bridge reads the saved loopback debugging port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-task-center-"));
  const file = path.join(root, "desktop-session.json");
  fs.writeFileSync(file, JSON.stringify({ debug_port: 53111 }));

  assert.equal(desktopDebugPort(file), 53111);
  assert.equal(desktopDebugPort(path.join(root, "missing.json")), null);
});
