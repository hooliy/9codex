import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TeamRuntime, prepareWorkerHome, preflightWorkerNode } from "../lib/team-runtime.mjs";
import { openTeamStore } from "../lib/team-store.mjs";

test("worker home preserves PATH behind the current Node.js binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-worker-home-"));
  const previousPath = process.env.PATH;
  process.env.PATH = "/original/bin";
  try {
    const env = prepareWorkerHome(
      { stateDir: root, catalog: path.join(root, "catalog.json") },
      {
        upstream: { default_model: "test-model" },
        local: { host: "127.0.0.1", port: 10101, token: "token" },
      },
    );
    assert.equal(env.PATH, `${path.dirname(process.execPath)}${path.delimiter}/original/bin`);
    assert.equal(env.NODE, process.execPath);
    assert.equal(env.NODE_EXEC_PATH, process.execPath);
    assert.equal(preflightWorkerNode(env).ok, true);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime blocks work items after one failed Worker Node.js preflight", async () => {
  const updates = [];
  let preflights = 0;
  let schedules = 0;
  const runtime = new TeamRuntime({
    config: { team: {} },
    store: {
      db: {
        prepare(sql) {
          return {
            run: (...args) => {
              if (sql.includes("UPDATE work_items")) updates.push({ sql, args });
            },
          };
        },
      },
      listTaskGroups: () => [{ id: "tg_1", status: "executing" }],
    },
    orchestrator: {
      recover: async () => ({ started: [] }),
      schedule: async () => { schedules += 1; return []; },
    },
    workerPreflight: () => {
      preflights += 1;
      return { ok: false, code: 127, signal: null, error: "node unavailable" };
    },
    onError() {},
  });

  await runtime.tick();
  await runtime.tick();

  assert.equal(preflights, 1);
  assert.equal(schedules, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /status = 'blocked'/);
  assert.match(updates[0].sql, /waiting_reason = \?/);
  assert.match(updates[0].args[0], /node unavailable/);
});

test("runtime supervises scheduled workers and records their report", async () => {
  const reports = [];
  const assignments = [{
    taskGroupId: "tg_1",
    workItemId: "wi_1",
    workerSessionId: "ws_1",
    runId: "run_1",
    workerId: "worker_1",
  }];
  const runtime = new TeamRuntime({
    config: { team: { lease_seconds: 60 } },
    paths: {},
    store: {
      listTaskGroups: () => [{ id: "tg_1", status: "executing" }],
    },
    adapter: {
      waitWorker: async () => ({ ok: true, code: 0 }),
      readEvents: () => [{ type: "message", text: "done" }],
    },
    orchestrator: {
      leaseTtlMs: 60_000,
      recover: async () => ({ started: [] }),
      schedule: async () => assignments.splice(0),
      heartbeat() {},
      async reportWorker(input) { reports.push(input); },
    },
    publishOutbox: async () => [],
    onError: (error) => { throw error; },
  });

  await runtime.tick();
  await Promise.all([...runtime.supervisions.values()]);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].workerSessionId, "ws_1");
  assert.equal(reports[0].report.summary, "done");
});

test("runtime renews worker heartbeats while a silent worker is running", async () => {
  const heartbeats = [];
  let finish;
  const runtime = new TeamRuntime({
    config: { team: { lease_seconds: 60 } },
    paths: {},
    store: { listTaskGroups: () => [{ id: "tg_1", status: "executing" }] },
    adapter: {
      workers: new Map([["worker_1", { lastEventAt: Date.now() }]]),
      waitWorker: () => new Promise((resolve) => { finish = resolve; }),
      readEvents: () => [],
      interruptWorker() {},
    },
    orchestrator: {
      heartbeatTimeoutMs: 20,
      recover: async () => ({ started: [] }),
      schedule: async () => [{
        taskGroupId: "tg_1", workItemId: "wi_1", workerSessionId: "ws_1", runId: "run_1", workerId: "worker_1",
      }],
      heartbeat(input) { heartbeats.push(input); },
      async reportWorker() {},
    },
    publishOutbox: async () => [],
    onError: (error) => { throw error; },
  });

  await runtime.tick();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  finish({ ok: true, code: 0 });
  await Promise.all([...runtime.supervisions.values()]);

  assert.equal(heartbeats.some((row) => row.workerSessionId === "ws_1"), true);
});

test("runtime sends non-zero worker exits directly to rework", async () => {
  const failures = [];
  const runtime = new TeamRuntime({
    config: { team: { lease_seconds: 60 } },
    paths: {},
    store: { listTaskGroups: () => [{ id: "tg_1", status: "executing" }] },
    adapter: {
      waitWorker: async () => ({ ok: false, code: 17, signal: null }),
      readEvents: () => [{ type: "adapter.stderr", text: "auth failed" }],
    },
    orchestrator: {
      leaseTtlMs: 60_000,
      schedule: async () => [{
        taskGroupId: "tg_1", workItemId: "wi_1", workerSessionId: "ws_1", runId: "run_1", workerId: "worker_1",
      }],
      recover: async () => ({ started: [] }),
      heartbeat() {},
      async failWorker(input) { failures.push(input); },
    },
    publishOutbox: async () => [],
    onError: (error) => { throw error; },
  });
  await runtime.tick();
  await Promise.all([...runtime.supervisions.values()]);
  assert.equal(failures[0].failure.exitCode, 17);
});

test("runtime observes only origin threads and stores sanitized gateway events", () => {
  const recorded = [];
  let group = null;
  const runtime = new TeamRuntime({
    defaultWorkspace: "/repo",
    store: {
      getTaskGroupByThread: () => group,
      createTaskGroup(input) {
        group = { id: "tg_1", ...input };
        return group;
      },
      recordExternalEvent(input) { recorded.push(input); },
    },
    onError() {},
  });

  assert.equal(runtime.observeTeamEvent({ type: "thread_observed", threadId: "thread-1", subagent: true }), null);
  runtime.observeTeamEvent({
    type: "thread_observed",
    threadId: "thread-1",
    requestId: "request-1",
    authorization: "secret",
    input: "private prompt",
    subagent: false,
  });

  assert.equal(group.originThreadId, "thread-1");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].payload.authorization, undefined);
  assert.equal(recorded[0].payload.input, undefined);
});

test("runtime syncs the task center bridge through the saved Codex debug port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-runtime-bridge-"));
  const desktopSession = path.join(root, "desktop-session.json");
  fs.writeFileSync(desktopSession, JSON.stringify({ debug_port: 53111 }));
  const calls = [];
  const runtime = new TeamRuntime({
    config: { team: { host: "127.0.0.1", port: 10102, token: "taskboard-token", max_workers: 20 } },
    paths: { desktopSession },
    store: {
      listTaskGroups: () => [{
        id: "tg_1",
        origin_thread_id: "thread-1",
        status: "executing",
        demand_count: 1,
        progress: 50,
        current_stage: "executing",
        running_workers: 1,
        blocker_count: 0,
      }],
      getTaskGroupSnapshot: () => ({
        demand_events: [],
        requirement_revisions: [],
        work_items: [],
        evidence: [],
        acceptances: [],
      }),
    },
    taskCenterBridgeApply: async (input) => {
      calls.push(input);
      return { connected: true, verified: true, tasks: input.taskGroups.length, actions: [] };
    },
    onError() {},
  });

  const result = await runtime.syncTaskCenterBridge();

  assert.equal(calls[0].port, 53111);
  assert.equal(calls[0].taskGroups[0].id, "global");
  assert.equal(calls[0].taskGroups[0].max_workers, 20);
  assert.match(calls[0].taskboardUrl, /#token=taskboard-token$/);
  assert.deepEqual(result, { connected: true, verified: true, tasks: 1, actions: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime confirms task-center actions without renderer network access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-runtime-confirm-"));
  const desktopSession = path.join(root, "desktop-session.json");
  fs.writeFileSync(desktopSession, JSON.stringify({ debug_port: 53111 }));
  const confirmations = [];
  const runtime = new TeamRuntime({
    config: { team: { host: "127.0.0.1", port: 10102, token: "taskboard-token" } },
    paths: { desktopSession },
    store: {
      listTaskGroups: () => [],
      get: () => ({ id: "tg_1", status: "awaiting_confirmation" }),
    },
    orchestrator: {
      async confirmDemand(input) { confirmations.push(input); },
    },
    taskCenterBridgeApply: async () => ({
      connected: true,
      verified: true,
      tasks: 1,
      actions: [{ type: "confirm", taskGroupId: "tg_1", eventKey: "thread:m1" }],
    }),
    onError() {},
  });

  await runtime.syncTaskCenterBridge();

  assert.equal(confirmations[0].eventKey, "thread:m1");
  assert.match(confirmations[0].approvalSourceMessageId, /^task-center:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime repairs a Codex launch without renderer debugging after repeated bridge failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-runtime-repair-"));
  const desktopSession = path.join(root, "desktop-session.json");
  fs.writeFileSync(desktopSession, JSON.stringify({ debug_port: 53111, process_ids: [111] }));
  const restarts = [];
  const runtime = new TeamRuntime({
    config: { team: { host: "127.0.0.1", port: 10102, token: "taskboard-token" } },
    paths: { desktopSession },
    store: {
      listTaskGroups: () => [],
    },
    taskCenterBridgeApply: async () => { throw new Error("fetch failed"); },
    listCodexProcesses: async () => [{ pid: 222 }],
    restartCodex: async (input) => {
      restarts.push(input);
      return { codex_restarted: true };
    },
    onError() {},
  });

  await runtime.syncTaskCenterBridge();
  await runtime.syncTaskCenterBridge();
  await runtime.syncTaskCenterBridge();
  await runtime.syncTaskCenterBridge();

  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].sessionFile, desktopSession);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime creates private timestamped database backups", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-runtime-"));
  const store = await openTeamStore(path.join(root, "team.sqlite"));
  const runtime = new TeamRuntime({
    paths: { backupsDir: path.join(root, "backups") },
    store,
    onError() {},
  });

  const result = await runtime.backup();

  assert.match(path.basename(result.path), /^team-\d+\.sqlite$/);
  assert.equal(result.restoreDrill, "passed");
  assert.equal(fs.statSync(path.dirname(result.path)).mode & 0o777, 0o700);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime delivers done and blocked outbox events to the origin thread", async () => {
  const calls = [];
  const rows = [
    { id: 1, topic: "task_group.status_changed", payload: { taskGroupId: "tg_1", to: "done" } },
    { id: 2, topic: "task_group.status_changed", payload: { taskGroupId: "tg_1", to: "blocked", reason: "credentials missing" } },
  ];
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-runtime-report-")), "final.json");
  fs.writeFileSync(report, '{"finalDecision":"passed"}');
  const runtime = new TeamRuntime({
    store: {
      pendingOutbox: () => rows,
      get: () => ({ id: "tg_1", origin_thread_id: "origin-thread", workspace: "/repo" }),
      db: {
        prepare(sql) {
          return { get: () => sql.includes("artifacts") ? { path: report } : null };
        },
      },
      getTaskGroupSnapshot: () => ({
        work_items: [{ id: "wi_1", title: "Blocked", status: "blocked" }],
        acceptances: [{ result: "failed", failure_reason: "auth failed" }],
      }),
      markOutboxPublished: (id) => calls.push(["published", id]),
      markOutboxFailed: (id, error) => calls.push(["failed", id, error]),
    },
    adapter: {
      resumeThread(threadId, message) {
        calls.push(["resume", threadId, message]);
        return { id: `delivery-${calls.length}` };
      },
      async waitWorker() { return { ok: true, code: 0 }; },
    },
    onError: (error) => { throw error; },
  });

  await runtime.publishOutbox();

  assert.equal(calls.filter(([type]) => type === "resume").length, 2);
  assert.match(calls.find(([type, , message]) => type === "resume" && message.includes("最终验收报告"))[2], /finalDecision/);
  assert.match(calls.find(([type, , message]) => type === "resume" && message.includes("真实阻断"))[2], /credentials missing/);
  assert.deepEqual(calls.filter(([type]) => type === "published").map(([, id]) => id), [1, 2]);
  fs.rmSync(path.dirname(report), { recursive: true, force: true });
});
