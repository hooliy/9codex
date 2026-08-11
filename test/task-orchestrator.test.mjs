import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskOrchestrator, TaskOrchestrator } from "../lib/task-orchestrator.mjs";
import { openTeamStore } from "../lib/team-store.mjs";

class FakeAdapter {
  constructor() {
    this.created = [];
    this.closed = [];
    this.interrupted = [];
  }

  createWorker(instruction, options) {
    const worker = {
      id: `worker-${this.created.length + 1}`,
      threadId: `internal-thread-${this.created.length + 1}`,
      instruction,
      cwd: options.cwd,
    };
    this.created.push(worker);
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
  const adapter = options.adapter || new FakeAdapter();
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
    adapter,
    workspaceManager,
    verificationRunner,
    artifactRoot: path.join(dir, "artifacts"),
    classifier: options.classifier,
    planner: options.planner,
    maxConcurrency: options.maxConcurrency,
    failureThreshold: options.failureThreshold,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    now: options.now,
  });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, adapter, workspaceManager, orchestrator };
}

function plan(workItems, requirement = {}) {
  return {
    requirement: {
      title: requirement.title || "Build feature",
      normalizedRequirement: requirement.normalizedRequirement || "Build the requested feature",
      acceptanceCriteria: requirement.acceptanceCriteria || [{ id: "all", command: ["node", "--test"] }],
      impactSummary: requirement.impactSummary || "planned",
    },
    workItems,
    impactActions: requirement.impactActions || {},
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
  assert.equal(waiting.proposedWorkItems.length, 1);
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
  assert.equal(adapter.closed.length, 1);
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

  const changed = await orchestrator.ingestDemand({ threadId: "thread-change", sourceMessageId: "m2", content: "Change behavior", workspace: "/repo" });
  assert.equal(changed.revision, 2);
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
