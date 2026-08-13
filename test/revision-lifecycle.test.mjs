import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateRequirementRevision,
  auditRevisionLifecycle,
  createAndActivateRequirementRevision,
  RevisionLifecycleCoordinator,
} from "../lib/revision-lifecycle.mjs";
import { classifyWorkItemState } from "../lib/work-item-state.mjs";
import { classifyWorkerLifecycle } from "../lib/worker-lifecycle.mjs";
import { openTeamStore } from "../lib/team-store.mjs";

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-revision-lifecycle-"));
  const store = await openTeamStore(path.join(directory, "team.sqlite"), {
    now: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  const group = store.createTaskGroup({
    originThreadId: "thread-revision",
    title: "Revision lifecycle",
    workspace: directory,
    status: "executing",
  });
  const requirement = store.createRequirement({ taskGroupId: group.id, title: "Current requirement" });
  const first = store.addRequirementRevision({
    requirementId: requirement.id,
    sourceMessageId: "message-1",
    normalizedRequirement: "first",
    acceptanceCriteria: [],
  });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, group, requirement, first };
}

function createRunningWorker(store, group, revision, status = "running") {
  const item = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: revision.id,
    title: `work-${revision.revision}`,
    status,
    writeSet: ["lib/example.mjs"],
  });
  const session = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    role: "worker",
    workspace: group.workspace,
    status: "running",
    lastHeartbeatAt: "2026-08-13T00:00:00.000Z",
  });
  const run = store.createRun({
    workerSessionId: session.id,
    workItemId: item.id,
    requirementRevisionId: revision.id,
    role: "worker",
    status: "running",
  });
  const lease = store.acquireWorkItemLease({
    workItemId: item.id,
    workerSessionId: session.id,
    now: "2026-08-13T00:00:00.000Z",
  });
  store.acquireResourceLock({
    resourceKey: "revision-lifecycle-state",
    taskGroupId: group.id,
    workItemId: item.id,
    workerSessionId: session.id,
    now: "2026-08-13T00:00:00.000Z",
  });
  return { item, session, run, lease };
}

test("pure classifiers distinguish historical, waiting, and isolatable state", () => {
  const historical = classifyWorkItemState({
    id: "wi-old",
    status: "ready",
    requirement_revision_id: "rr-old",
  }, { currentRevisionId: "rr-new" });
  assert.equal(historical.classification, "historical_revision");
  assert.equal(historical.runnable, false);

  const waiting = classifyWorkItemState({
    id: "wi-current",
    status: "ready",
    requirement_revision_id: "rr-new",
  }, {
    currentRevisionId: "rr-new",
    dependencies: ["wi-dependency"],
    dependencyStatus: new Map([["wi-dependency", "running"]]),
  });
  assert.equal(waiting.classification, "dependency_wait");
  assert.deepEqual(waiting.unmetDependencies, ["wi-dependency"]);

  const worker = classifyWorkerLifecycle({
    id: "ws-old",
    work_item_id: "wi-old",
    role: "worker",
    status: "running",
  }, {
    currentRevisionId: "rr-new",
    workItem: { id: "wi-old", status: "running", requirement_revision_id: "rr-old" },
    run: { id: "run-old", status: "running", requirement_revision_id: "rr-old" },
  });
  assert.equal(worker.classification, "superseded_revision");
  assert.equal(worker.isolate, true);

  const otherCurrentRequirement = classifyWorkItemState({
    id: "wi-other-current-requirement",
    status: "ready",
    requirement_revision_id: "rr-other-current",
  }, {
    currentRevisionId: "rr-new",
    currentRevisionIds: new Set(["rr-new", "rr-other-current"]),
  });
  assert.equal(otherCurrentRequirement.historical, false);

  const inconsistent = classifyWorkerLifecycle({
    id: "ws-mismatch",
    work_item_id: "wi-current",
    role: "worker",
    status: "running",
  }, {
    currentRevisionId: "rr-new",
    workItem: { id: "wi-current", status: "running", requirement_revision_id: "rr-new" },
    run: {
      id: "run-mismatch",
      work_item_id: "wi-other",
      status: "running",
      requirement_revision_id: "rr-new",
    },
  });
  assert.equal(inconsistent.classification, "worker_association_mismatch");
  assert.equal(inconsistent.isolate, true);
  assert.equal(inconsistent.reason, "run_work_item_mismatch");

  const closedWithRun = classifyWorkerLifecycle({
    id: "ws-closed",
    work_item_id: "wi-current",
    role: "worker",
    status: "closed",
  }, {
    currentRevisionId: "rr-new",
    workItem: { id: "wi-current", status: "running", requirement_revision_id: "rr-new" },
    run: { id: "run-closed", status: "running", requirement_revision_id: "rr-new" },
  });
  assert.equal(closedWithRun.classification, "closed_session_with_active_run");
  assert.equal(closedWithRun.isolate, true);
});

test("activation atomically marks the revision current and revokes historical worker authority", async (t) => {
  const { store, group, requirement, first } = await fixture(t);
  const old = createRunningWorker(store, group, first);
  const second = store.addRequirementRevision({
    requirementId: requirement.id,
    sourceMessageId: "message-2",
    normalizedRequirement: "second",
    acceptanceCriteria: [],
  });
  const current = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: second.id,
    title: "current-ready",
    status: "ready",
  });
  const interrupted = [];
  const released = [];
  const runtime = new Map([[old.session.id, { worker: { id: "process-old" } }]]);

  const result = await activateRequirementRevision({
    store,
    revisionId: second.id,
    maxWorkers: 2,
    runtime,
    adapter: { interruptWorker(worker) { interrupted.push(worker.id); } },
    workspaceManager: { release(id) { released.push(id); } },
    now: () => new Date("2026-08-13T00:01:00.000Z"),
  });

  assert.equal(store.get("task_groups", group.id).current_requirement_revision_id, second.id);
  assert.equal(store.get("requirement_revisions", first.id).status, "superseded");
  assert.equal(store.get("requirement_revisions", second.id).status, "active");
  assert.equal(store.get("work_items", old.item.id).status, "stale");
  assert.equal(store.get("work_items", current.id).status, "ready");
  assert.equal(store.get("worker_sessions", old.session.id).status, "interrupted");
  assert.equal(store.get("runs", old.run.id).status, "interrupted");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_item_leases WHERE worker_session_id = ?").get(old.session.id).count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM resource_locks WHERE worker_session_id = ?").get(old.session.id).count, 0);
  assert.deepEqual(interrupted, ["process-old"]);
  assert.deepEqual(released, [old.item.id]);
  assert.equal(runtime.has(old.session.id), false);
  assert.equal(result.audit.counts.workersToIsolate, 1);
  assert.deepEqual(result.isolatedWorkers.map((entry) => entry.workerSessionId), [old.session.id]);

  const auditEvent = store.listEvents(group.id).find((event) => event.event_type === "revision_lifecycle.audit_recorded");
  assert.equal(auditEvent.payload.audit.currentRequirementRevisionId, second.id);
  assert.equal(auditEvent.payload.audit.workItems.some((entry) => (
    entry.workItemId === old.item.id && entry.waitingReason === "requirement_revision_superseded"
  )), true);
});

test("audit records dependency, capacity, acceptance, and non-retryable failure waits", async (t) => {
  const { store, group, first } = await fixture(t);
  const dependency = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "dependency",
    status: "running",
  });
  const dependent = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "dependent",
    status: "ready",
  });
  store.addWorkItemDependency(dependent.id, dependency.id);
  const verifying = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "verify",
    status: "verifying",
  });
  const blocked = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "blocked",
    status: "blocked",
  });

  const audit = auditRevisionLifecycle({
    store,
    revisionId: first.id,
    maxWorkers: 1,
    nonRetryableWorkItemIds: [blocked.id],
    now: () => new Date("2026-08-13T00:02:00.000Z"),
  });
  const byId = new Map(audit.workItems.map((entry) => [entry.workItemId, entry]));
  assert.equal(byId.get(dependent.id).classification, "dependency_wait");
  assert.deepEqual(byId.get(dependent.id).waitingBasis, {
    unmetDependencies: [dependency.id],
  });
  assert.equal(byId.get(verifying.id).classification, "acceptance_wait");
  assert.equal(byId.get(blocked.id).classification, "failed_non_retryable");
  assert.equal(audit.waitingReasons[blocked.id].reason, "retry_forbidden");
});

test("audit derives persisted resource-lock waits from the work item's write set", async (t) => {
  const { store, group, first } = await fixture(t);
  const holder = createRunningWorker(store, group, first);
  const waiting = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "waiting-for-resource",
    status: "ready",
    writeSet: ["revision-lifecycle-state"],
  });

  const audit = auditRevisionLifecycle({
    store,
    revisionId: first.id,
    maxWorkers: 2,
    now: "2026-08-13T00:02:30.000Z",
  });
  const entry = audit.workItems.find((item) => item.workItemId === waiting.id);
  assert.equal(entry.classification, "lock_wait");
  assert.deepEqual(entry.lockConflicts, ["revision-lifecycle-state"]);
  assert.equal(
    audit.workItems.find((item) => item.workItemId === holder.item.id).classification,
    "running",
  );
});

test("coordinator creates and activates a new revision with a persisted audit", async (t) => {
  const { store, group, requirement, first } = await fixture(t);
  const coordinator = new RevisionLifecycleCoordinator({ store, maxWorkers: 3 });
  const result = await coordinator.createAndActivate({
    requirementId: requirement.id,
    sourceMessageId: "message-2",
    normalizedRequirement: "second",
    acceptanceCriteria: [{ id: "test", command: ["node", "--test"] }],
    now: () => new Date("2026-08-13T00:03:00.000Z"),
  });
  assert.equal(result.revision.revision, 2);
  assert.equal(result.revision.status, "active");
  assert.equal(store.get("requirement_revisions", first.id).status, "superseded");
  assert.equal(result.audit.previousCurrentRequirementRevisionId, first.id);
  const activationEvent = store.listEvents(group.id).find((event) => (
    event.event_type === "requirement_revision.activated"
    && event.aggregate_id === result.revision.id
  ));
  assert.equal(activationEvent.payload.previousRevisionId, first.id);

  const third = await createAndActivateRequirementRevision({
    store,
    requirementId: requirement.id,
    sourceMessageId: "message-3",
    normalizedRequirement: "third",
    now: () => new Date("2026-08-13T00:04:00.000Z"),
  });
  assert.equal(third.revision.revision, 3);
  assert.equal(third.audit.currentRequirementRevisionId, third.revision.id);
});

test("audit derives stale workers from persisted heartbeat timestamps", async (t) => {
  const { store, group, first } = await fixture(t);
  const active = createRunningWorker(store, group, first);
  store.db.prepare(
    "UPDATE worker_sessions SET last_heartbeat_at = ? WHERE id = ?",
  ).run("2026-08-12T23:00:00.000Z", active.session.id);

  const audit = auditRevisionLifecycle({
    store,
    revisionId: first.id,
    heartbeatTimeoutMs: 60_000,
    now: "2026-08-13T00:10:00.000Z",
  });
  const worker = audit.workers.find((entry) => entry.workerSessionId === active.session.id);
  assert.equal(worker.classification, "stale_worker");
  assert.equal(worker.reason, "stale_heartbeat");
  assert.equal(worker.isolate, true);
  assert.equal(audit.activeWorkers, 0);
  assert.equal(audit.isolationReasons[active.session.id].basis.lastHeartbeatAt, "2026-08-12T23:00:00.000Z");
});

test("create-and-activate rolls back the new revision when durable reconciliation fails", async (t) => {
  const { store, group, requirement, first } = await fixture(t);
  const originalRecordExternalEvent = store.recordExternalEvent.bind(store);
  store.recordExternalEvent = (event) => {
    if (event.eventType === "revision_lifecycle.audit_recorded") {
      throw new Error("injected audit persistence failure");
    }
    return originalRecordExternalEvent(event);
  };

  await assert.rejects(
    createAndActivateRequirementRevision({
      store,
      requirementId: requirement.id,
      sourceMessageId: "message-2",
      normalizedRequirement: "second",
      now: "2026-08-13T00:04:30.000Z",
    }),
    /injected audit persistence failure/,
  );
  assert.equal(store.get("requirement_revisions", first.id).status, "active");
  assert.equal(store.get("task_groups", group.id).current_requirement_revision_id, first.id);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM requirement_revisions WHERE requirement_id = ?").get(requirement.id).count,
    1,
  );
});

test("activation preserves work for other active requirements and quarantines idle historical workers", async (t) => {
  const { store, group, requirement, first } = await fixture(t);
  const otherRequirement = store.createRequirement({
    taskGroupId: group.id,
    title: "Other requirement",
  });
  const otherRevision = store.addRequirementRevision({
    requirementId: otherRequirement.id,
    sourceMessageId: "other-message-1",
    normalizedRequirement: "other",
    acceptanceCriteria: [],
  });
  const otherItem = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: otherRevision.id,
    title: "other-ready",
    status: "ready",
  });
  const oldItem = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: first.id,
    title: "old-idle",
    status: "ready",
  });
  const idleSession = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: oldItem.id,
    role: "worker",
    workspace: group.workspace,
    status: "idle",
  });
  const second = store.addRequirementRevision({
    requirementId: requirement.id,
    sourceMessageId: "message-2",
    normalizedRequirement: "second",
    acceptanceCriteria: [],
  });

  const result = await activateRequirementRevision({
    store,
    revisionId: second.id,
    now: "2026-08-13T00:05:00.000Z",
  });

  assert.equal(store.get("requirement_revisions", otherRevision.id).status, "active");
  assert.equal(store.get("work_items", otherItem.id).status, "ready");
  assert.equal(store.get("work_items", oldItem.id).status, "stale");
  assert.equal(store.get("worker_sessions", idleSession.id).status, "interrupted");
  assert.equal(
    result.audit.workItems.find((entry) => entry.workItemId === otherItem.id).historical,
    false,
  );
});
