import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskOrchestrator, TaskOrchestrator } from "../lib/task-orchestrator.mjs";
import { openTeamStore } from "../lib/team-store.mjs";

class FakeRuntime {
  constructor(runtimeKind = "codex") {
    this.runtime_kind = runtimeKind;
    this.created = [];
    this.provisioned = [];
    this.closed = [];
    this.interrupted = [];
    this.workers = new Map();
    this.nextWorker = 1;
  }

  createWorker(instruction, options) {
    const number = this.nextWorker++;
    const worker = {
      id: `worker-${number}`,
      runtime_kind: this.runtime_kind,
      sessionId: `${this.runtime_kind}-session-${number}`,
      instruction,
      cwd: options.cwd,
    };
    this.created.push(worker);
    this.workers.set(worker.id, worker);
    options.onEvent?.({
      sequence: 1,
      type: "session.created",
      runtime_kind: this.runtime_kind,
      worker_id: worker.id,
      session_id: worker.sessionId,
      run_id: null,
      data: {},
    }, worker);
    return worker;
  }

  async createThread(instruction, options) {
    const number = this.nextWorker++;
    const worker = {
      id: `provisioned-${number}`,
      runtime_kind: this.runtime_kind,
      sessionId: `${this.runtime_kind}-session-${number}`,
      instruction,
      cwd: options.cwd,
    };
    this.provisioned.push(worker);
    return worker;
  }

  resumeThread(sessionId, instruction, options) {
    const worker = this.createWorker(instruction, options);
    worker.sessionId = sessionId;
    return worker;
  }

  interruptWorker(worker) {
    this.interrupted.push(worker.id);
    return true;
  }

  async closeWorker(worker) {
    this.closed.push(worker.id);
    return { ok: true };
  }

  forgetWorker(worker) {
    this.workers.delete(worker.id);
    return true;
  }
}

function overlaps(left, right) {
  return left === "**" || right === "**" || left === right
    || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

class FakeWorkspaceManager {
  constructor(root) {
    this.root = root;
    this.claims = new Map();
    this.worktrees = [];
    this.scopeError = null;
    this.commits = [];
    this.integrations = [];
    this.deleted = [];
  }

  checkConflicts(owner, claim) {
    const writeSet = claim.writeSet || claim.write_set || [];
    const readSet = claim.readSet || claim.read_set || [];
    const resourceLocks = claim.resourceLocks || claim.resource_locks || [];
    const conflicts = [];
    for (const [heldBy, held] of this.claims) {
      if (heldBy === owner) continue;
      const heldWrite = held.writeSet || [];
      const heldRead = held.readSet || [];
      if (
        writeSet.some((a) => heldWrite.some((b) => overlaps(a, b)))
        || writeSet.some((a) => heldRead.some((b) => overlaps(a, b)))
        || readSet.some((a) => heldWrite.some((b) => overlaps(a, b)))
        || resourceLocks.some((key) => held.resourceLocks.includes(key))
      ) conflicts.push({ heldBy });
    }
    return conflicts;
  }

  hold(owner, claim) {
    if (this.checkConflicts(owner, claim).length) throw new Error("Workspace claim conflicts");
    this.claims.set(owner, {
      writeSet: claim.writeSet || [],
      readSet: claim.readSet || [],
      resourceLocks: claim.resourceLocks || [],
    });
  }

  release(owner) {
    return this.claims.delete(owner);
  }

  createWorktree({ taskGroup, workItem, branch }) {
    const worktree = path.join(this.root, taskGroup, workItem);
    fs.mkdirSync(worktree, { recursive: true });
    const result = { worktree, branch, exists: true, clean: true };
    this.worktrees.push(result);
    return result;
  }

  assertWriteScope() {
    if (this.scopeError) throw this.scopeError;
    return true;
  }

  commitWorktree(options) {
    const result = { committed: true, head: `commit-${this.commits.length + 1}`, changed_files: options.writeSet };
    this.commits.push({ ...options, result });
    return result;
  }

  async mergeAccepted(options) {
    this.integrations.push(options);
    for (const entry of options.items) {
      const result = await options.runTests({ item: entry, worktree: this.worktrees.find((row) => row.branch === entry.branch)?.worktree });
      if (!result) throw new Error("integration tests failed");
    }
    return { merged: options.items.map((entry) => entry.id), head: "integrated-head" };
  }

  deleteWorktree(options) {
    this.deleted.push(options);
    return { deleted: true };
  }
}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-task-orchestrator-"));
  const store = await openTeamStore(path.join(dir, "team.sqlite"), options.storeOptions);
  const adapter = options.adapter || new FakeRuntime();
  const harnessRuntime = options.harnessRuntime || new FakeRuntime("deepseek-harness");
  const workspaceManager = options.workspaceManager || new FakeWorkspaceManager(path.join(dir, "worktrees"));
  const verificationResults = [...(options.verificationResults || [{
    result: "passed",
    evidence: [{
      type: "test",
      source: "fake-verifier",
      criterion_id: "tests",
      command: ["node", "--test"],
      exit_code: 0,
      result: "passed",
      content_hash: "passed-hash",
    }],
  }])];
  const verificationRunner = options.verificationRunner || (async () => verificationResults.shift() || verificationResults.at(-1));
  const orchestrator = createTaskOrchestrator({
    store,
    codexRuntime: adapter,
    harnessRuntime,
    workspaceManager,
    verificationRunner,
    artifactRoot: path.join(dir, "artifacts"),
    classifier: options.classifier,
    planner: options.planner,
    maxConcurrency: options.maxConcurrency,
    failureThreshold: options.failureThreshold,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    verificationEnv: options.verificationEnv,
    publishThread: options.publishThread,
    now: options.now,
    wait: options.wait || (async () => {}),
  });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, adapter, harnessRuntime, workspaceManager, orchestrator };
}

function plan(workItems, requirement = {}) {
  return {
    summary: requirement.normalizedRequirement || "Build the requested feature",
    questions: [],
    requirements: [{
      key: requirement.key || "requirement-1",
      requirementId: requirement.requirementId || null,
      title: requirement.title || "Build feature",
      normalizedRequirement: requirement.normalizedRequirement || "Build the requested feature",
      acceptanceCriteria: requirement.acceptanceCriteria || [{ id: "all", command: ["node", "--test"] }],
      impactSummary: requirement.impactSummary || "planned",
      impactActions: requirement.impactActions || {},
      workItems,
    }],
  };
}

function item(key, writeSet, dependencies = [], extra = {}) {
  return {
    key,
    title: key,
    description: `Implement ${key}`,
    writeSet,
    readSet: extra.readSet || [],
    resourceLocks: extra.resourceLocks || [],
    dependencies,
    acceptanceCriteria: [{ id: `${key}-test`, command: ["node", "--test"] }],
  };
}

test("planner failure returns the task group to collecting for retry", async (t) => {
  const { store, orchestrator } = await fixture(t, {
    classifier: async () => ({ type: "bug_report", confidence: 0.9, highImpact: false }),
    planner: async () => { throw new Error("planner unavailable"); },
  });

  await assert.rejects(
    () => orchestrator.ingestDemand({
      threadId: "thread-planner-failure",
      sourceMessageId: "message-planner-failure",
      content: "修复任务入队",
      workspace: "/repo",
    }),
    /planner unavailable/,
  );

  assert.equal(store.getTaskGroupByThread("thread-planner-failure").status, "collecting");
  assert.equal(
    store.db.prepare("SELECT processed_at FROM demand_events WHERE source_message_id = ?")
      .get("message-planner-failure").processed_at,
    null,
  );
});

test("first bug report waits for confirmation before creating work", async (t) => {
  const { store, orchestrator } = await fixture(t, {
    classifier: async () => ({ type: "bug_report", confidence: 0.9, highImpact: false }),
    planner: async () => plan([item("fix", ["lib/fix.mjs"])]),
  });

  const result = await orchestrator.ingestDemand({
    threadId: "thread-first-bug",
    sourceMessageId: "message-first-bug",
    content: "修复任务入队",
    workspace: "/repo",
  });

  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(store.getTaskGroupByThread("thread-first-bug").status, "awaiting_confirmation");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS count FROM work_items WHERE task_group_id = ?",
  ).get(result.taskGroupId).count, 0);
});

function latestWorker(store, workItemId) {
  return store.db.prepare(`
    SELECT * FROM worker_sessions WHERE work_item_id = ? AND role = 'worker'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(workItemId);
}

function runningRun(store, workerSessionId) {
  return store.db.prepare(`SELECT * FROM runs WHERE worker_session_id = ? AND status = 'running'`).get(workerSessionId);
}

const pass = (hash = "passed-hash") => ({
  result: "passed",
  evidence: [{ type: "test", source: "fake-verifier", criterion_id: "tests", command: ["node", "--test"], exit_code: 0, result: "passed", content_hash: hash }],
});

const fail = (hash = "same-failure") => ({
  result: "failed",
  evidence: [{ type: "test", source: "fake-verifier", criterion_id: "tests", command: ["node", "--test"], exit_code: 1, result: "failed", content_hash: hash }],
});

async function ingestConfirmed(orchestrator, input) {
  const result = await orchestrator.ingestDemand(input);
  return result.status === "awaiting_confirmation"
    ? orchestrator.confirmDemand({ eventKey: `${input.threadId}:${input.sourceMessageId}`, approved: true })
    : result;
}

function replanReasons(store, taskGroupId) {
  return store.listEvents(taskGroupId)
    .filter((event) => event.event_type === "project_manager.replanned")
    .map((event) => event.payload.reason);
}

test("exports factory/class, deduplicates DemandEvent, keeps one TaskGroup, and confirms risky low-confidence demand", async (t) => {
  assert.equal(typeof TaskOrchestrator, "function");
  const { orchestrator, store } = await fixture(t, {
    classifier: async () => ({ type: "new_requirement", confidence: 0.4, highImpact: true }),
    planner: async ({ content }) => plan([item("implementation", ["lib/a.mjs"])], { normalizedRequirement: content }),
  });
  const input = {
    threadId: "user-thread",
    sourceMessageId: "message-1",
    content: "Replace the public API",
    workspace: "/repo",
  };
  const waiting = await orchestrator.ingestDemand(input);
  assert.equal(waiting.status, "awaiting_confirmation");
  assert.equal(waiting.proposedRequirements[0].workItems.length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM task_groups").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirement_revisions").get().count, 0);

  const retry = await orchestrator.ingestDemand({ ...input, content: "must not overwrite" });
  assert.deepEqual(retry, waiting);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM demand_events").get().count, 1);

  const confirmed = await orchestrator.confirmDemand({ eventKey: "user-thread:message-1", approved: true });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.status, "executing");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirement_revisions").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 1);

  await orchestrator.ingestDemand({
    threadId: "user-thread",
    sourceMessageId: "message-2",
    content: "Another requirement",
    workspace: "/repo",
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM task_groups").get().count, 1);
});

test("confirmation executes the displayed proposal without replanning drift", async (t) => {
  let plannerCalls = 0;
  const frozen = plan([item("frozen", ["lib/frozen.mjs"])], {
    normalizedRequirement: "已展示的需求",
  });
  const { orchestrator, store } = await fixture(t, {
    planner: async () => {
      plannerCalls += 1;
      return plannerCalls === 1
        ? frozen
        : plan([item("drifted", ["lib/drifted.mjs"])], { normalizedRequirement: "漂移需求" });
    },
  });

  const waiting = await orchestrator.ingestDemand({
    threadId: "proposal-no-drift",
    sourceMessageId: "m1",
    content: "实现功能",
    workspace: "/repo",
  });
  const confirmed = await orchestrator.confirmDemand({
    eventKey: "proposal-no-drift:m1",
    approved: true,
  });

  assert.equal(plannerCalls, 1);
  assert.equal(waiting.proposal.requirements[0].normalizedRequirement, "已展示的需求");
  assert.equal(waiting.proposal.requirements[0].workItems[0].key, "frozen");
  assert.equal(confirmed.summary, frozen.summary);
  assert.equal(
    store.db.prepare("SELECT normalized_requirement FROM requirement_revisions").get().normalized_requirement,
    "已展示的需求",
  );
  assert.equal(
    JSON.parse(store.db.prepare("SELECT description FROM work_items").get().description).key,
    "frozen",
  );
});

test("one sourced demand creates multiple active requirements with auditable revisions", async (t) => {
  const source = {
    kind: "document",
    reference: "/tmp/plan.docx",
    fingerprint: "sha256:abc",
    metadata: { page: 2 },
  };
  const proposal = {
    summary: "前后端两个独立结果",
    questions: [],
    requirements: [
      plan([item("frontend", ["ui/app.mjs"])], {
        key: "frontend",
        title: "前端",
        normalizedRequirement: "实现前端",
      }).requirements[0],
      plan([item("backend", ["lib/api.mjs"])], {
        key: "backend",
        title: "后端",
        normalizedRequirement: "实现后端",
      }).requirements[0],
    ],
  };
  const { orchestrator, store } = await fixture(t);

  const waiting = await orchestrator.ingestDemand({
    threadId: "multi-requirement",
    sourceMessageId: "m1",
    content: "读取计划并执行",
    workspace: "/repo",
    source,
    proposal,
  });
  assert.equal(waiting.status, "awaiting_confirmation");
  assert.deepEqual(waiting.source, source);
  assert.equal(waiting.proposedRequirements.length, 2);

  const confirmed = await orchestrator.confirmDemand({
    eventKey: "multi-requirement:m1",
    approved: true,
  });
  const eventRow = store.db.prepare("SELECT id FROM demand_events WHERE event_key = ?").get("multi-requirement:m1");
  const event = store.get("demand_events", eventRow.id);
  const revisions = store.db.prepare(
    "SELECT * FROM requirement_revisions ORDER BY revision, id",
  ).all();

  assert.equal(confirmed.requirements.length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM demand_events").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirements").get().count, 2);
  assert.equal(revisions.length, 2);
  assert.equal(revisions.every((revision) => revision.status === "active"), true);
  assert.equal(store.listReadyWorkItems(confirmed.taskGroupId).length, 2);
  assert.equal(event.source_kind, source.kind);
  assert.equal(event.source_reference, source.reference);
  assert.equal(event.source_fingerprint, source.fingerprint);
  assert.deepEqual(event.source_metadata, source.metadata);
  assert.equal(event.confirmed_at, confirmed.confirmedAt);
  for (const revision of revisions) {
    assert.equal(revision.source_event_id, event.id);
    assert.equal(revision.source_kind, source.kind);
    assert.equal(revision.source_reference, source.reference);
    assert.equal(revision.source_fingerprint, source.fingerprint);
    assert.equal(revision.confirmed_at, confirmed.confirmedAt);
  }
  assert.equal(replanReasons(store, confirmed.taskGroupId).includes("new_requirement"), true);
});

test("proposal cannot revise a requirement owned by another task group", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("first", ["lib/first.mjs"])]),
  });
  const first = await ingestConfirmed(orchestrator, {
    threadId: "scope-first",
    sourceMessageId: "m1",
    content: "第一个项目",
    workspace: "/repo",
  });
  const foreignRequirementId = first.requirements[0].requirementId;
  const foreignProposal = plan([item("intrusion", ["lib/intrusion.mjs"])], {
    requirementId: foreignRequirementId,
    normalizedRequirement: "越权修改",
  });
  const waiting = await orchestrator.ingestDemand({
    threadId: "scope-second",
    sourceMessageId: "m1",
    content: "第二个项目",
    workspace: "/repo",
    proposal: foreignProposal,
  });

  await assert.rejects(
    () => orchestrator.confirmDemand({ eventKey: "scope-second:m1", approved: true }),
    /requirement belongs to another task group/,
  );
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) count FROM requirement_revisions WHERE requirement_id = ?",
  ).get(foreignRequirementId).count, 1);
});

test("first requirement always waits for explicit user confirmation", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  const waiting = await orchestrator.ingestDemand({
    threadId: "first-confirmation",
    sourceMessageId: "m1",
    content: "Build a normal feature",
    workspace: "/repo",
  });
  assert.equal(waiting.status, "awaiting_confirmation");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 0);
  await orchestrator.confirmDemand({ eventKey: "first-confirmation:m1", approved: true });
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 1);
});

test("Harness projects persist Runtime snapshots and never publish Codex threads", async (t) => {
  const published = [];
  const {
    adapter,
    harnessRuntime,
    orchestrator,
    store,
  } = await fixture(t, {
    publishThread: async (input) => published.push(input),
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "harness-project",
    sourceMessageId: "m1",
    content: "Build with Harness",
    workspace: "/repo",
    runtimeKind: "deepseek-harness",
  });

  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  const group = store.get("task_groups", demand.taskGroupId);
  const session = store.get("worker_sessions", assignment.workerSessionId);
  const run = store.get("runs", assignment.runId);

  assert.equal(group.runtime_kind, "deepseek-harness");
  assert.equal(assignment.runtimeKind, "deepseek-harness");
  assert.equal(adapter.provisioned.length, 0);
  assert.equal(harnessRuntime.created.length, 1);
  assert.equal(session.runtime_kind, "deepseek-harness");
  assert.equal(session.runtime_session_id, harnessRuntime.created[0].sessionId);
  assert.equal(run.runtime_kind, "deepseek-harness");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) count FROM conversation_bindings WHERE worker_session_id = ?",
  ).get(session.id).count, 0);
  assert.deepEqual(published, []);

  await orchestrator.cancel(demand.taskGroupId);
  assert.deepEqual(harnessRuntime.interrupted, [harnessRuntime.created[0].id]);
  assert.deepEqual(adapter.interrupted, []);
});

test("independent verification receives the configured executable environment", async (t) => {
  const calls = [];
  const { orchestrator } = await fixture(t, {
    verificationEnv: { PATH: "/node-bin:/usr/bin" },
    verificationRunner: async (_criteria, options) => {
      calls.push(options);
      return pass();
    },
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "verification-env",
    sourceMessageId: "m1",
    content: "Build it",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { ok: true },
  });
  assert.equal(calls[0].env.PATH, "/node-bin:/usr/bin");
});

test("package verification ignores lockfiles generated by install criteria", async (t) => {
  let scopeOptions;
  const workspaceManager = new FakeWorkspaceManager(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-install-scope-")));
  workspaceManager.assertWriteScope = (options) => {
    scopeOptions = options;
    return true;
  };
  const { orchestrator } = await fixture(t, {
    workspaceManager,
    planner: async () => plan([{
      ...item("install", []),
      acceptanceCriteria: [{ id: "install", command: ["npm", "install"] }],
    }]),
    verificationRunner: async () => pass(),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "verification-install-lock",
    sourceMessageId: "m1",
    content: "Install",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { ok: true },
  });

  assert.deepEqual(scopeOptions.ignoredFiles, [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]);
});

test("synchronous reviewer and integrator sessions start with heartbeats", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "reviewer-heartbeat",
    sourceMessageId: "m1",
    content: "Build it",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { ok: true },
  });
  const sessions = store.db.prepare(`
    SELECT role, last_heartbeat_at FROM worker_sessions
    WHERE task_group_id = ? AND role IN ('reviewer','integrator')
  `).all(demand.taskGroupId);
  assert.equal(sessions.length >= 2, true);
  assert.equal(sessions.every((row) => row.last_heartbeat_at), true);
});

test("expanded Chinese confirmation approves the pending plan", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  await orchestrator.ingestDemand({
    threadId: "expanded-confirmation",
    sourceMessageId: "m1",
    content: "Build a normal feature",
    workspace: "/repo",
  });
  const confirmed = await orchestrator.ingestDemand({
    threadId: "expanded-confirmation",
    sourceMessageId: "m2",
    content: "确认执行",
    workspace: "/repo",
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 1);
});

test("short Chinese approval binds to the latest pending proposal instead of creating a requirement", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  await orchestrator.ingestDemand({
    threadId: "short-confirmation",
    sourceMessageId: "m1",
    content: "Build a normal feature",
    workspace: "/repo",
  });
  const confirmed = await orchestrator.ingestDemand({
    threadId: "short-confirmation",
    sourceMessageId: "m2",
    content: "好",
    workspace: "/repo",
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirements").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 1);
});

test("discussion does not create work and explicit immediate execution skips confirmation", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("implementation", ["lib/a.mjs"])]),
  });
  const discussion = await orchestrator.ingestDemand({
    threadId: "discussion-vs-execution",
    sourceMessageId: "m1",
    content: "先讨论一下这个方案应该怎么设计",
    workspace: "/repo",
  });
  assert.equal(discussion.discussion, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 0);

  const execution = await orchestrator.ingestDemand({
    threadId: "discussion-vs-execution",
    sourceMessageId: "m2",
    content: "严重 Bug，立即修复，不要再次确认",
    workspace: "/repo",
  });
  assert.equal(execution.status, "executing");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items").get().count, 1);
});

test("creates a verifiable DAG, enforces dependencies/write sets/resource locks, isolated worktrees, and global max three workers", async (t) => {
  const { orchestrator, store, adapter, workspaceManager } = await fixture(t, {
    planner: async () => plan([
      item("a", ["lib/a.mjs"]),
      item("b", ["lib/b.mjs"]),
      item("c", ["lib/c.mjs"], [], { resourceLocks: ["port:3000"] }),
      item("d", ["lib/d.mjs"], [], { resourceLocks: ["port:3000"] }),
      item("e", ["lib/a.mjs"]),
      item("f", ["lib/f.mjs"], ["a"]),
    ]),
  });
  const demand = await ingestConfirmed(orchestrator, { threadId: "thread-dag", sourceMessageId: "m1", content: "Build DAG", workspace: "/repo" });
  assert.equal(demand.workItems.length, 6);

  const started = await orchestrator.schedule(demand.taskGroupId);
  assert.equal(started.length, 3);
  assert.equal(adapter.created.length, 3);
  assert.equal(workspaceManager.worktrees.length, 3);
  assert.equal(new Set(workspaceManager.worktrees.map((row) => row.worktree)).size, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM worker_sessions WHERE role='worker' AND status='running'").get().count, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_item_leases").get().count, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM resource_locks").get().count, 1);
  for (const worker of adapter.created) {
    const handoff = JSON.parse(worker.instruction);
    assert.equal(handoff.type, "handoff_packet");
    assert.equal(handoff.selfAcceptanceForbidden, undefined);
    assert.equal(handoff.reporting.selfAcceptanceForbidden, true);
    assert.equal(worker.cwd, handoff.workspace);
  }
  assert.equal((await orchestrator.schedule(demand.taskGroupId)).length, 0);
  const dependency = store.db.prepare(`SELECT COUNT(*) count FROM work_item_dependencies`).get().count;
  assert.equal(dependency, 1);
});

test("supports up to twenty concurrent independent workers", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    maxConcurrency: 20,
    planner: async () => plan(Array.from({ length: 25 }, (_, index) => (
      item(`parallel-${index + 1}`, [`lib/parallel-${index + 1}.mjs`])
    ))),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "thread-concurrency-20",
    sourceMessageId: "m1",
    content: "Build independent work",
    workspace: "/repo",
  });

  const started = await orchestrator.schedule(demand.taskGroupId);

  assert.equal(started.length, 20);
  assert.equal(
    store.db.prepare(
      "SELECT COUNT(*) count FROM worker_sessions WHERE role='worker' AND status='running'",
    ).get().count,
    20,
  );
  assert.equal(store.listReadyWorkItems(demand.taskGroupId).length, 5);
});

test("worker report requires Reviewer and Integrator Runs, evidence, commit, merge, cleanup, and final report", async (t) => {
  const { orchestrator, store, adapter, workspaceManager } = await fixture(t, {
    planner: async () => plan([item("only", ["lib/only.mjs"])]),
    verificationResults: [pass("review"), pass("integration"), pass("final")],
  });
  const demand = await ingestConfirmed(orchestrator, { threadId: "thread-pass", sourceMessageId: "m1", content: "Build it", workspace: "/repo" });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  const before = store.get("work_items", assignment.workItemId);
  assert.equal(before.status, "running");

  const result = await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { summary: "done", changedFiles: ["lib/only.mjs"] },
  });
  assert.equal(result.result, "passed");
  assert.notEqual(result.reviewerRunId, assignment.runId);
  assert.equal(store.get("runs", assignment.runId).status, "reported");
  assert.equal(store.get("runs", result.reviewerRunId).role, "reviewer");
  assert.equal(store.get("runs", result.reviewerRunId).status, "passed");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runs WHERE role='integrator' AND status='passed'").get().count, 2);
  assert.equal(store.get("work_items", assignment.workItemId).status, "closed");
  assert.equal(store.get("worker_sessions", assignment.workerSessionId).status, "closed");
  assert.equal(adapter.closed.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence WHERE work_item_id = ?").get(assignment.workItemId).count, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence WHERE type='commit'").get().count, 1);
  assert.equal(workspaceManager.commits.length, 1);
  assert.equal(workspaceManager.integrations.length, 1);
  assert.equal(workspaceManager.deleted.length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM acceptances WHERE scope='work_item' AND result='passed'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM acceptances WHERE scope='requirement' AND result='passed'").get().count, 1);
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "done");
  assert.equal(result.finalReport.finalDecision, "passed");
  assert.equal(fs.existsSync(result.finalReport.path), true);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM artifacts WHERE kind='final_report'").get().count, 1);
  assert.equal(replanReasons(store, demand.taskGroupId).includes("work_item_accepted"), true);
});

test("read-only accepted work closes without merging a dirty target worktree", async (t) => {
  const workspaceManager = new FakeWorkspaceManager("/tmp/worktrees");
  workspaceManager.commitWorktree = (options) => {
    workspaceManager.commits.push(options);
    return { committed: false, head: "unchanged-head", changed_files: [] };
  };
  workspaceManager.mergeAccepted = async () => {
    throw new Error("Target worktree is dirty: /repo");
  };
  const { orchestrator, store } = await fixture(t, {
    workspaceManager,
    planner: async () => plan([item("inspect", [])]),
    verificationResults: [pass("review"), pass("final")],
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "thread-read-only",
    sourceMessageId: "m1",
    content: "Inspect only",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);

  const result = await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { summary: "inspection complete", changedFiles: [] },
  });

  assert.equal(result.result, "passed");
  assert.equal(result.integration, null);
  assert.equal(store.get("work_items", assignment.workItemId).status, "closed");
  assert.equal(workspaceManager.integrations.length, 0);
});

test("failed verification creates ready rework; repeated identical fingerprint blocks at threshold", async (t) => {
  const results = [fail(), fail()];
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("retry", ["lib/retry.mjs"])]),
    failureThreshold: 2,
    verificationRunner: async () => results.shift(),
  });
  const demand = await ingestConfirmed(orchestrator, { threadId: "thread-fail", sourceMessageId: "m1", content: "Build it", workspace: "/repo" });

  const [first] = await orchestrator.schedule(demand.taskGroupId);
  const firstResult = await orchestrator.reportWorker({ workerSessionId: first.workerSessionId, runId: first.runId, report: { done: true } });
  assert.equal(firstResult.result, "failed");
  assert.equal(store.get("work_items", first.workItemId).status, "ready");
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "executing");

  const [second] = await orchestrator.schedule(demand.taskGroupId);
  assert.notEqual(second.workerSessionId, first.workerSessionId);
  const secondResult = await orchestrator.reportWorker({ workerSessionId: second.workerSessionId, runId: second.runId, report: { done: true } });
  assert.equal(secondResult.result, "blocked");
  assert.equal(secondResult.failureFingerprint, firstResult.failureFingerprint);
  assert.equal(store.get("work_items", second.workItemId).status, "blocked");
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "blocked");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM acceptances WHERE result='failed'").get().count, 2);
  assert.equal(replanReasons(store, demand.taskGroupId).filter((reason) => reason === "verification_failed").length, 2);
});

test("worker process failure blocks automatic retry and preserves evidence", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("worker-failure", ["lib/failure.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "worker-failure",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);

  const result = await orchestrator.failWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    failure: { type: "worker_process", exitCode: 17, message: "auth failed" },
  });

  assert.equal(result.status, "blocked");
  assert.equal(store.get("work_items", assignment.workItemId).status, "blocked");
  assert.equal(store.get("runs", assignment.runId).status, "failed");
  assert.equal(store.get("worker_sessions", assignment.workerSessionId).status, "interrupted");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence WHERE work_item_id = ?").get(assignment.workItemId).count, 1);
  assert.deepEqual(await orchestrator.schedule(demand.taskGroupId), []);
});

test("recoverable model-call faults rebuild from checkpoint twice then block the repeated fingerprint", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("self-heal", ["lib/self-heal.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "self-heal",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  let [assignment] = await orchestrator.schedule(demand.taskGroupId);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const previousSessionId = assignment.workerSessionId;
    const recovered = await orchestrator.recoverWorker({
      workerSessionId: assignment.workerSessionId,
      runId: assignment.runId,
      failure: {
        category: "upstream_stream_stalled",
        recoverable: true,
        code: "MODEL_CALL_STALLED",
        phase: "model_waiting",
      },
    });
    assert.equal(recovered.status, "recovering");
    assert.equal(recovered.attempt, attempt);
    assert.equal(recovered.started.length, 1);
    if (attempt === 1) {
      assert.equal(recovered.started[0].workerSessionId, previousSessionId);
    } else {
      assert.notEqual(recovered.started[0].workerSessionId, previousSessionId);
    }
    assignment = recovered.started[0];
  }

  const blocked = await orchestrator.recoverWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    failure: {
      category: "upstream_stream_stalled",
      recoverable: true,
      code: "MODEL_CALL_STALLED",
      phase: "model_waiting",
    },
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.attempt, 3);
  assert.equal(store.get("work_items", assignment.workItemId).status, "blocked");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) count FROM evidence WHERE work_item_id = ? AND type = 'model_call'",
  ).get(assignment.workItemId).count, 3);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) count FROM checkpoints WHERE work_item_id = ?",
  ).get(assignment.workItemId).count >= 3, true);
  assert.deepEqual(await orchestrator.schedule(demand.taskGroupId), []);
});

test("non-recoverable model-call faults block immediately", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("auth-failure", ["lib/auth.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "auth-failure",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);

  const result = await orchestrator.recoverWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    failure: {
      category: "upstream_authentication_failed",
      recoverable: false,
      code: "HTTP_401",
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.attempt, 1);
  assert.equal(store.get("work_items", assignment.workItemId).status, "blocked");
});

test("manual work-item retry creates a new worker and keeps failure history", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("manual-retry", ["lib/retry.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "manual-retry",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  const [first] = await orchestrator.schedule(demand.taskGroupId);
  await orchestrator.failWorker({
    workerSessionId: first.workerSessionId,
    runId: first.runId,
    failure: { type: "worker_process", exitCode: 1 },
  });

  assert.deepEqual(
    await orchestrator.retryWorkItem(demand.taskGroupId, first.workItemId),
    { workItemId: first.workItemId, status: "ready" },
  );
  const [second] = await orchestrator.schedule(demand.taskGroupId);

  assert.notEqual(second.workerSessionId, first.workerSessionId);
  assert.equal(store.get("worker_sessions", first.workerSessionId).status, "interrupted");
  assert.equal(store.get("runs", first.runId).status, "failed");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence WHERE work_item_id = ?").get(first.workItemId).count, 1);
  assert.equal(replanReasons(store, demand.taskGroupId).includes("user_retry_work_item"), true);
});

test("stopping one running work item checkpoints and releases its assignment", async (t) => {
  const { orchestrator, store, adapter, workspaceManager } = await fixture(t, {
    planner: async () => plan([item("stop-running", ["lib/stop.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "stop-running",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);

  assert.deepEqual(
    await orchestrator.stopWorkItem(demand.taskGroupId, assignment.workItemId),
    { workItemId: assignment.workItemId, status: "blocked" },
  );

  assert.equal(store.get("work_items", assignment.workItemId).status, "blocked");
  assert.equal(store.get("runs", assignment.runId).status, "interrupted");
  assert.equal(store.get("worker_sessions", assignment.workerSessionId).status, "interrupted");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM checkpoints WHERE work_item_id = ?").get(assignment.workItemId).count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_item_leases WHERE work_item_id = ?").get(assignment.workItemId).count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM resource_locks WHERE work_item_id = ?").get(assignment.workItemId).count, 0);
  assert.equal(workspaceManager.claims.has(assignment.workItemId), false);
  assert.deepEqual(adapter.interrupted, [assignment.workerId]);
});

test("paused task groups reject single-item retry until the group is resumed", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("paused-retry", ["lib/paused.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "paused-retry",
    sourceMessageId: "m1",
    content: "Run the worker",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  await orchestrator.failWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    failure: { type: "worker_process", exitCode: 1 },
  });
  await orchestrator.pause(demand.taskGroupId);

  await assert.rejects(
    () => orchestrator.retryWorkItem(demand.taskGroupId, assignment.workItemId),
    /paused task group/,
  );
  await orchestrator.resume(demand.taskGroupId);
  assert.equal(store.get("work_items", assignment.workItemId).status, "ready");
});

test("pause, resume, and cancel control the task group without user-managed internal sessions", async (t) => {
  const { orchestrator, store, adapter } = await fixture(t, {
    planner: async () => plan([item("one", ["lib/one.mjs"]), item("two", ["lib/two.mjs"])]),
    maxConcurrency: 1,
  });
  const demand = await ingestConfirmed(orchestrator, { threadId: "thread-control", sourceMessageId: "m1", content: "Build it", workspace: "/repo" });
  const [first] = await orchestrator.schedule(demand.taskGroupId);
  assert.equal(store.get("work_items", first.workItemId).status, "running");

  const paused = await orchestrator.pause(demand.taskGroupId);
  assert.equal(paused.status, "paused");
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "paused");
  assert.equal(store.get("work_items", first.workItemId).status, "ready");
  assert.equal(adapter.interrupted.length, 1);

  const resumed = await orchestrator.resume(demand.taskGroupId);
  assert.equal(resumed.status, "executing");
  assert.equal(resumed.started.length, 0);
  const [resumedAssignment] = await orchestrator.schedule(demand.taskGroupId);
  assert.notEqual(resumedAssignment.workerSessionId, first.workerSessionId);

  const canceled = await orchestrator.cancel(demand.taskGroupId);
  assert.equal(canceled.status, "canceled");
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "canceled");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_items WHERE status <> 'canceled'").get().count, 0);
});

test("resume retries blocked work from active revisions", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("one", ["lib/one.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "thread-resume-blocked",
    sourceMessageId: "m1",
    content: "Build it",
    workspace: "/repo",
  });
  const work = store.db.prepare("SELECT * FROM work_items WHERE task_group_id = ?").get(demand.taskGroupId);
  store.updateWorkItemStatus(work.id, {
    expectedVersion: work.version,
    status: "blocked",
    reason: "test_blocker",
  });
  const group = store.get("task_groups", demand.taskGroupId);
  store.updateTaskGroupStatus(group.id, {
    expectedVersion: group.version,
    status: "blocked",
    reason: "test_blocker",
  });

  await orchestrator.resume(demand.taskGroupId);

  assert.equal(store.get("work_items", work.id).status, "ready");
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "executing");
});

test("requirement change versions demand, interrupts old worker, and marks affected work for rework/stale/revalidation", async (t) => {
  let call = 0;
  let oldItemId;
  const { orchestrator, store, adapter } = await fixture(t, {
    classifier: async ({ hasRequirements }) => ({ type: hasRequirements ? "requirement_change" : "new_requirement", confidence: 0.95, highImpact: false }),
    planner: async () => {
      call += 1;
      return call === 1
        ? plan([item("old", ["lib/old.mjs"])], { normalizedRequirement: "v1" })
        : plan([item("new", ["lib/new.mjs"])], { normalizedRequirement: "v2", impactActions: { [oldItemId]: "rework" } });
    },
  });
  const first = await ingestConfirmed(orchestrator, { threadId: "thread-change", sourceMessageId: "m1", content: "Initial", workspace: "/repo" });
  oldItemId = first.workItems[0];
  await orchestrator.schedule(first.taskGroupId);

  const waiting = await orchestrator.ingestDemand({ threadId: "thread-change", sourceMessageId: "m2", content: "Change behavior", workspace: "/repo" });
  assert.equal(waiting.status, "awaiting_confirmation");
  const changed = await orchestrator.confirmDemand({ eventKey: "thread-change:m2", approved: true });
  assert.equal(changed.requirements[0].revision, 2);
  assert.deepEqual(changed.affectedWorkItems, [{ id: oldItemId, action: "rework" }]);
  assert.equal(store.get("work_items", oldItemId).status, "rework");
  assert.equal(adapter.interrupted.length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirement_revisions").get().count, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM requirement_revisions WHERE status='active'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM task_groups").get().count, 1);
});

test("heartbeats renew leases, checkpoints persist, scope drift fails review, and recovery replaces lost workers within the recovery tick", async (t) => {
  let now = new Date("2026-08-11T00:00:00.000Z");
  const { orchestrator, store, workspaceManager, adapter } = await fixture(t, {
    planner: async () => plan([item("recover", ["lib/recover.mjs"])]),
    now: () => now,
    heartbeatTimeoutMs: 1_000,
    verificationResults: [pass()],
  });
  const demand = await ingestConfirmed(orchestrator, { threadId: "thread-recover", sourceMessageId: "m1", content: "Recover it", workspace: "/repo" });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  const oldLease = store.db.prepare("SELECT * FROM work_item_leases WHERE work_item_id = ?").get(assignment.workItemId);

  now = new Date("2026-08-11T00:00:00.500Z");
  const heartbeat = orchestrator.heartbeat({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    progressSummary: "halfway",
    changedFiles: ["lib/recover.mjs"],
    nextStep: "finish",
  });
  const renewedLease = store.db.prepare("SELECT * FROM work_item_leases WHERE work_item_id = ?").get(assignment.workItemId);
  assert.notEqual(renewedLease.expires_at, oldLease.expires_at);
  assert.equal(heartbeat.checkpoint.payload.progressSummary, "halfway");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM checkpoints").get().count, 1);

  workspaceManager.scopeError = new Error("Changed files exceed write_set");
  const scopeFailure = await orchestrator.reportWorker({ workerSessionId: assignment.workerSessionId, runId: assignment.runId, report: { done: true } });
  assert.equal(scopeFailure.result, "failed");
  assert.equal(store.get("work_items", assignment.workItemId).status, "ready");
  assert.equal(store.db.prepare("SELECT metadata FROM evidence ORDER BY created_at DESC LIMIT 1").get().metadata.includes("Changed files exceed write_set"), true);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM checkpoints").get().count, 2);

  workspaceManager.scopeError = null;
  const [replacementCandidate] = await orchestrator.schedule(demand.taskGroupId);
  const replacementSession = store.get("worker_sessions", replacementCandidate.workerSessionId);
  store.db.prepare("UPDATE worker_sessions SET last_heartbeat_at = ? WHERE id = ?").run("2026-08-10T23:00:00.000Z", replacementSession.id);
  now = new Date("2026-08-11T00:01:00.000Z");
  const recovered = await orchestrator.recover({ staleBefore: "2026-08-11T00:00:59.000Z" });
  assert.equal(recovered.interruptedRuns, 1);
  assert.equal(recovered.readyWorkItems.includes(assignment.workItemId), true);
  assert.equal(store.get("worker_sessions", replacementSession.id).status, "lost");
  assert.equal(recovered.started.length, 1);
  assert.notEqual(recovered.started[0].workerSessionId, replacementSession.id);
  assert.equal(recovered.recoveredWithinMs <= 60_000, true);
  const newHandoff = JSON.parse(adapter.created.at(-1).instruction);
  assert.equal(newHandoff.checkpoint.progressSummary, "halfway");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence").get().count > 0, true);
  assert.equal(replanReasons(store, demand.taskGroupId).includes("worker_recovered"), true);
});

test("daemon restart mode immediately reclaims every persisted running worker", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("restart", ["lib/restart.mjs"])]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "thread-restart",
    sourceMessageId: "m1",
    content: "Restart recovery",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  assert.equal(store.get("runs", assignment.runId).status, "running");

  const recovered = await orchestrator.recover({ recoverAllRunning: true });

  assert.equal(recovered.interruptedRuns, 1);
  assert.equal(store.get("runs", assignment.runId).status, "interrupted");
  assert.equal(store.get("worker_sessions", assignment.workerSessionId).status, "lost");
  assert.equal(recovered.started.length, 1);
  assert.notEqual(recovered.started[0].workerSessionId, assignment.workerSessionId);
});

test("daemon recovery finishes work whose reviewer passed before restart", async (t) => {
  const { orchestrator, store } = await fixture(t, {
    planner: async () => plan([item("recover acceptance", [])]),
    verificationResults: [pass(), pass()],
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "thread-recover-acceptance",
    sourceMessageId: "m1",
    content: "Recover acceptance",
    workspace: "/repo",
  });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  const work = store.get("work_items", assignment.workItemId);
  store.updateRunStatus(assignment.runId, {
    expectedVersion: store.get("runs", assignment.runId).version,
    status: "reported",
    reason: "worker_reported",
  });
  store.updateWorkItemStatus(work.id, {
    expectedVersion: work.version,
    status: "reported",
    reason: "worker_reported",
  });
  const reported = store.get("work_items", work.id);
  store.updateWorkItemStatus(work.id, {
    expectedVersion: reported.version,
    status: "verifying",
    reason: "independent_review_started",
  });
  const workerSession = store.get("worker_sessions", assignment.workerSessionId);
  store.updateWorkerSessionStatus(workerSession.id, {
    expectedVersion: workerSession.version,
    status: "waiting",
    reason: "awaiting_independent_review",
  });
  const reviewer = store.createWorkerSession({
    taskGroupId: demand.taskGroupId,
    workItemId: work.id,
    role: "reviewer",
    status: "running",
    workspace: "/repo",
  });
  let reviewerRun = store.createRun({
    workerSessionId: reviewer.id,
    workItemId: work.id,
    requirementRevisionId: work.requirement_revision_id,
    role: "reviewer",
    status: "running",
  });
  reviewerRun = store.updateRunStatus(reviewerRun.id, {
    expectedVersion: reviewerRun.version,
    status: "passed",
    reason: "criteria_passed",
  });
  store.updateWorkerSessionStatus(reviewer.id, {
    expectedVersion: store.get("worker_sessions", reviewer.id).version,
    status: "closed",
    reason: "review_complete",
  });

  const recovered = await orchestrator.recover();

  assert.equal(recovered.resumedAcceptances.length, 1);
  assert.equal(store.get("work_items", work.id).status, "closed");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM acceptances WHERE scope_id = ? AND result = 'passed'").get(work.id).count,
    1,
  );
});

test("deleteWorkItem stops only its worker and preserves sibling execution", async (t) => {
  const { orchestrator, store, adapter, workspaceManager } = await fixture(t, {
    planner: async () => plan([
      item("delete-me", ["lib/delete-me.mjs"]),
      item("keep-me", ["lib/keep-me.mjs"]),
    ]),
  });
  const demand = await ingestConfirmed(orchestrator, {
    threadId: "delete-one",
    sourceMessageId: "m1",
    content: "Run two items",
    workspace: "/repo",
  });
  const assignments = await orchestrator.schedule(demand.taskGroupId);
  const target = assignments.find((row) => row.workItemId === demand.workItems[0]);
  const sibling = assignments.find((row) => row.workItemId === demand.workItems[1]);

  assert.equal(await orchestrator.deleteWorkItem(demand.taskGroupId, target.workItemId), true);
  assert.equal(store.get("work_items", target.workItemId), undefined);
  assert.equal(store.get("worker_sessions", target.workerSessionId), undefined);
  assert.equal(store.get("work_items", sibling.workItemId).status, "running");
  assert.equal(store.get("worker_sessions", sibling.workerSessionId).status, "running");
  assert.deepEqual(adapter.interrupted, [target.workerId]);
  assert.deepEqual(adapter.closed, [target.workerId]);
  assert.equal(orchestrator.runtime.has(sibling.workerSessionId), true);
  assert.equal(workspaceManager.claims.has(sibling.workItemId), true);
});

test("deleteTaskGroup and clearTaskGroups stop scoped workers before deletion", async (t) => {
  const { orchestrator, store, adapter } = await fixture(t, {
    planner: async ({ content }) => plan([item(content, [`lib/${content}.mjs`])]),
  });
  const first = await ingestConfirmed(orchestrator, {
    threadId: "delete-group-one",
    sourceMessageId: "m1",
    content: "one",
    workspace: "/repo",
  });
  const second = await ingestConfirmed(orchestrator, {
    threadId: "delete-group-two",
    sourceMessageId: "m1",
    content: "two",
    workspace: "/repo",
  });
  const [firstWorker] = await orchestrator.schedule(first.taskGroupId);
  const [secondWorker] = await orchestrator.schedule(second.taskGroupId);

  assert.equal(await orchestrator.deleteTaskGroup(first.taskGroupId), true);
  assert.equal(store.get("task_groups", first.taskGroupId), undefined);
  assert.equal(store.get("task_groups", second.taskGroupId).id, second.taskGroupId);
  assert.deepEqual(adapter.closed, [firstWorker.workerId]);
  assert.equal(store.get("worker_sessions", secondWorker.workerSessionId).status, "running");

  assert.equal(await orchestrator.clearTaskGroups(), 1);
  assert.equal(store.listTaskGroups().length, 0);
  assert.deepEqual(adapter.closed, [firstWorker.workerId, secondWorker.workerId]);
  assert.equal(orchestrator.runtime.size, 0);
});
