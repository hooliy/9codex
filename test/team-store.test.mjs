import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  CURRENT_SCHEMA_VERSION,
  TeamStoreError,
  TeamStoreMigrationError,
  openTeamStore,
  verifyTeamStoreBackup,
} from "../lib/team-store.mjs";

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-team-store-"));
  const dbPath = path.join(dir, "team.sqlite");
  const store = await openTeamStore(dbPath, options);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, store };
}

function graph(store) {
  const group = store.createTaskGroup({
    originThreadId: "thread-user",
    title: "Persistent team",
    workspace: "/repo",
  });
  const requirement = store.createRequirement({
    taskGroupId: group.id,
    title: "Persist work",
  });
  const revision = store.addRequirementRevision({
    requirementId: requirement.id,
    sourceMessageId: "message-1",
    normalizedRequirement: "Persist all orchestration state",
    acceptanceCriteria: ["survives restart"],
  });
  const item = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: revision.id,
    title: "Create task store",
    status: "ready",
    writeSet: ["lib/team-store.mjs"],
    acceptanceCriteria: ["tests pass"],
  });
  return { group, requirement, revision, item };
}

test("creates the complete versioned SQLite schema with operational pragmas", async (t) => {
  const { store } = await fixture(t);
  const tables = new Set(store.db.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));
  for (const name of [
    "task_groups", "conversation_bindings", "demand_events", "requirements",
    "requirement_revisions", "work_items", "work_item_dependencies", "worker_sessions",
    "runs", "events", "checkpoints", "resource_locks", "evidence", "acceptances",
    "artifacts", "outbox", "schema_migrations",
  ]) assert.equal(tables.has(name), true, `missing ${name}`);

  assert.equal(store.pragma("journal_mode").journal_mode, "wal");
  assert.equal(store.pragma("foreign_keys").foreign_keys, 1);
  assert.equal(store.pragma("busy_timeout").timeout, 5000);
  assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(store.path)).mode & 0o777, 0o700);
  assert.equal(store.pragma("user_version").user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    store.db.prepare("SELECT version FROM schema_migrations").all().map((row) => ({ ...row })),
    [{ version: 1 }, { version: 2 }, { version: 3 }],
  );
  assert.equal(store.getTaskGroupByThread("missing"), undefined);
});

test("binds one user conversation to one task group and deduplicates DemandEvent", async (t) => {
  const { store } = await fixture(t);
  const first = store.createTaskGroup({
    originThreadId: "thread-1",
    title: "One",
    workspace: "/repo",
  });
  const same = store.createTaskGroup({
    originThreadId: "thread-1",
    title: "Ignored retry",
    workspace: "/repo",
  });
  assert.equal(same.id, first.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM task_groups").get().count, 1);

  const input = {
    eventKey: "thread-1:message-1",
    taskGroupId: first.id,
    sourceMessageId: "message-1",
    rawContent: "Implement persistence",
    classifiedType: "new_requirement",
    classificationConfidence: 0.99,
  };
  const inserted = store.appendDemandEvent(input);
  const retried = store.appendDemandEvent({ ...input, rawContent: "must not overwrite" });
  assert.equal(inserted.created, true);
  assert.equal(retried.created, false);
  assert.equal(retried.event.id, inserted.event.id);
  assert.equal(retried.event.raw_content, "Implement persistence");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM demand_events").get().count, 1);
});

test("enforces foreign keys, dependency constraints, leases, locks, and one running run", async (t) => {
  const { store } = await fixture(t);
  const { group, revision, item } = graph(store);
  const second = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: revision.id,
    title: "Second",
    status: "ready",
  });
  assert.throws(
    () => store.addWorkItemDependency(item.id, item.id),
    /CHECK constraint failed|work_item_id <> depends_on_id/,
  );
  assert.throws(
    () => store.createWorkItem({
      taskGroupId: "missing",
      requirementRevisionId: revision.id,
      title: "Foreign key failure",
    }),
    /FOREIGN KEY constraint failed/,
  );

  const worker1 = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    role: "worker",
    workspace: "/repo",
    status: "running",
  });
  const worker2 = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    role: "worker",
    workspace: "/repo",
    status: "idle",
  });
  store.createRun({ workerSessionId: worker1.id, workItemId: item.id, status: "running" });
  assert.throws(
    () => store.createRun({ workerSessionId: worker1.id, workItemId: item.id, status: "running" }),
    /UNIQUE constraint failed: runs.worker_session_id/,
  );

  const lease = store.acquireWorkItemLease({
    workItemId: item.id,
    workerSessionId: worker1.id,
    now: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T00:01:00.000Z",
  });
  assert.throws(
    () => store.acquireWorkItemLease({
      workItemId: item.id,
      workerSessionId: worker2.id,
      now: "2026-08-11T00:00:30.000Z",
      expiresAt: "2026-08-11T00:02:00.000Z",
    }),
    (error) => error instanceof TeamStoreError && error.code === "lease_conflict",
  );
  assert.equal(store.releaseWorkItemLease(item.id, lease.token), true);

  store.acquireResourceLock({
    resourceKey: "file:lib/team-store.mjs",
    taskGroupId: group.id,
    workItemId: item.id,
    workerSessionId: worker1.id,
    now: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T00:01:00.000Z",
  });
  assert.throws(
    () => store.acquireResourceLock({
      resourceKey: "file:lib/team-store.mjs",
      taskGroupId: group.id,
      workItemId: second.id,
      workerSessionId: worker2.id,
      now: "2026-08-11T00:00:30.000Z",
    }),
    (error) => error instanceof TeamStoreError && error.code === "resource_locked",
  );
});

test("ready queue includes only the task group's current revision", async (t) => {
  const { store } = await fixture(t);
  const { group, requirement, item: historical } = graph(store);
  const currentRevision = store.addRequirementRevision({
    requirementId: requirement.id,
    sourceMessageId: "message-2",
    normalizedRequirement: "Use only current work",
    acceptanceCriteria: ["current passes"],
  });
  const current = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: currentRevision.id,
    title: "Current work",
    status: "ready",
  });

  assert.deepEqual(
    store.listReadyWorkItems(group.id).map((item) => item.id),
    [current.id],
  );
  assert.equal(store.get("work_items", historical.id).status, "ready");
});

test("uses optimistic versions and commits state, event, outbox atomically", async (t) => {
  const { store } = await fixture(t);
  const { item } = graph(store);
  const beforeEvents = store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const beforeOutbox = store.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count;

  const running = store.updateWorkItemStatus(item.id, {
    expectedVersion: item.version,
    status: "running",
    reason: "leased",
  });
  assert.equal(running.version, item.version + 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    beforeEvents + 1,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count,
    beforeOutbox + 1,
  );
  const event = store.listEvents(item.task_group_id).at(-1);
  const outbox = store.db.prepare("SELECT * FROM outbox ORDER BY id DESC LIMIT 1").get();
  assert.equal(outbox.event_id, event.id);
  assert.equal(event.event_type, "work_item.status_changed");

  assert.throws(
    () => store.updateWorkItemStatus(item.id, {
      expectedVersion: item.version,
      status: "reported",
    }),
    (error) => error instanceof TeamStoreError && error.code === "version_conflict",
  );
  assert.equal(store.get("work_items", item.id).status, "running");
});

test("rolls back domain state, event, and outbox together", async (t) => {
  const { store } = await fixture(t);
  const { item } = graph(store);
  const before = {
    item: store.get("work_items", item.id),
    events: store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    outbox: store.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count,
  };

  assert.throws(() => store.transaction(() => {
    store.updateWorkItemStatus(item.id, {
      expectedVersion: item.version,
      status: "running",
    });
    throw new Error("crash after transition");
  }), /crash after transition/);

  assert.deepEqual(store.get("work_items", item.id), before.item);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, before.events);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, before.outbox);
});

test("deletes one work item lifecycle transactionally without deleting sibling work", async (t) => {
  const { store } = await fixture(t);
  const { group, revision, item } = graph(store);
  const sibling = store.createWorkItem({
    taskGroupId: group.id,
    requirementRevisionId: revision.id,
    parentId: item.id,
    title: "Sibling",
    status: "ready",
    dependencies: [item.id],
  });
  const worker = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    runtimeSessionId: "internal-delete-worker",
    role: "reviewer",
    workspace: "/repo",
    status: "running",
  });
  const run = store.createRun({
    workerSessionId: worker.id,
    workItemId: item.id,
    requirementRevisionId: revision.id,
    role: "reviewer",
    status: "running",
  });
  const checkpoint = store.saveCheckpoint({
    taskGroupId: group.id,
    workItemId: item.id,
    workerSessionId: worker.id,
    runId: run.id,
    payload: { next: "delete" },
  });
  const evidence = store.addEvidence({
    taskGroupId: group.id,
    workItemId: item.id,
    runId: run.id,
    type: "test",
    source: "node:test",
  });
  const artifact = store.addArtifact({
    taskGroupId: group.id,
    workItemId: item.id,
    evidenceId: evidence.id,
    kind: "log",
    path: "/tmp/delete.log",
  });
  const acceptance = store.addAcceptance({
    taskGroupId: group.id,
    scope: "work_item",
    scopeId: item.id,
    criteria: ["deleted"],
    result: "failed",
    evidenceIds: [evidence.id],
    failureReason: "pending deletion",
    verifiedByRunId: run.id,
  });
  store.acquireWorkItemLease({
    workItemId: item.id,
    workerSessionId: worker.id,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  store.acquireResourceLock({
    resourceKey: "delete:item",
    taskGroupId: group.id,
    workItemId: item.id,
    workerSessionId: worker.id,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const aggregateIds = [item.id, worker.id, run.id, checkpoint.id, evidence.id, acceptance.id, artifact.id];

  store.db.exec(`
    CREATE TEMP TRIGGER reject_delete BEFORE DELETE ON work_items
    BEGIN SELECT RAISE(ABORT, 'rollback deletion'); END;
  `);
  assert.throws(() => store.deleteWorkItem(group.id, item.id), /rollback deletion/);
  assert.equal(store.get("work_items", item.id).id, item.id);
  assert.equal(store.get("worker_sessions", worker.id).id, worker.id);
  store.db.exec("DROP TRIGGER reject_delete");

  assert.equal(store.deleteWorkItem(group.id, item.id), true);
  assert.equal(store.deleteWorkItem(group.id, item.id), false);
  assert.equal(store.get("work_items", item.id), undefined);
  assert.equal(store.get("worker_sessions", worker.id), undefined);
  assert.equal(store.get("runs", run.id), undefined);
  assert.equal(store.get("checkpoints", checkpoint.id), undefined);
  assert.equal(store.get("evidence", evidence.id), undefined);
  assert.equal(store.get("acceptances", acceptance.id), undefined);
  assert.equal(store.get("artifacts", artifact.id), undefined);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM work_item_leases WHERE work_item_id = ?").get(item.id).count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM resource_locks WHERE work_item_id = ?").get(item.id).count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM conversation_bindings WHERE worker_session_id = ?").get(worker.id).count, 0);
  assert.equal(store.db.prepare(
    `SELECT COUNT(*) count FROM events WHERE aggregate_id IN (${aggregateIds.map(() => "?").join(",")})`,
  ).get(...aggregateIds).count, 0);
  assert.equal(store.get("work_items", sibling.id).id, sibling.id);
  assert.equal(store.get("work_items", sibling.id).parent_id, null);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) count FROM work_item_dependencies WHERE work_item_id = ? OR depends_on_id = ?",
  ).get(sibling.id, item.id).count, 0);
});

test("deletes and clears task groups with all cascaded lifecycle state", async (t) => {
  const { store } = await fixture(t);
  const first = graph(store);
  const second = store.createTaskGroup({
    originThreadId: "thread-second",
    title: "Second",
    workspace: "/repo",
  });
  store.appendDemandEvent({
    eventKey: "thread-second:message-1",
    taskGroupId: second.id,
    sourceMessageId: "message-1",
    rawContent: "Keep until clear",
  });

  assert.equal(store.deleteTaskGroup(first.group.id), true);
  assert.equal(store.deleteTaskGroup(first.group.id), false);
  assert.equal(store.get("task_groups", first.group.id), undefined);
  assert.equal(store.get("task_groups", second.id).id, second.id);
  assert.equal(store.clearTaskGroups(), 1);
  assert.equal(store.clearTaskGroups(), 0);
  assert.equal(store.listTaskGroups().length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM events").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM outbox").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 3);
});

test("requires independent evidence-backed acceptance before closing work or task group", async (t) => {
  const { store } = await fixture(t);
  const { group, revision, item } = graph(store);
  assert.throws(
    () => store.updateWorkItemStatus(item.id, {
      expectedVersion: item.version,
      status: "closed",
    }),
    (error) => error.code === "acceptance_required",
  );
  assert.throws(
    () => store.addAcceptance({
      taskGroupId: group.id,
      scope: "work_item",
      scopeId: item.id,
      criteria: ["tests pass"],
      result: "passed",
      evidenceIds: [],
    }),
    (error) => error.code === "evidence_required",
  );
  const unreviewedEvidence = store.addEvidence({
    taskGroupId: group.id,
    workItemId: item.id,
    type: "test",
    source: "node:test",
    exitCode: 0,
  });
  assert.throws(
    () => store.addAcceptance({
      taskGroupId: group.id,
      scope: "work_item",
      scopeId: item.id,
      criteria: ["tests pass"],
      result: "passed",
      evidenceIds: [unreviewedEvidence.id],
    }),
    (error) => error.code === "reviewer_required",
  );
  const reviewer = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    role: "reviewer",
    workspace: "/repo",
  });
  const reviewRun = store.createRun({
    workerSessionId: reviewer.id,
    workItemId: item.id,
    requirementRevisionId: revision.id,
    role: "reviewer",
  });
  const passedReviewRun = store.updateRunStatus(reviewRun.id, {
    expectedVersion: reviewRun.version,
    status: "passed",
  });
  const evidence = store.addEvidence({
    taskGroupId: group.id,
    workItemId: item.id,
    runId: passedReviewRun.id,
    type: "test",
    source: "node:test",
    command: "node --test test/team-store.test.mjs",
    exitCode: 0,
  });
  store.addAcceptance({
    taskGroupId: group.id,
    scope: "work_item",
    scopeId: item.id,
    criteria: ["tests pass"],
    result: "passed",
    evidenceIds: [evidence.id],
    verifiedByRunId: passedReviewRun.id,
  });
  const closed = store.updateWorkItemStatus(item.id, {
    expectedVersion: item.version,
    status: "closed",
  });
  assert.equal(closed.status, "closed");

  assert.throws(
    () => store.updateTaskGroupStatus(group.id, {
      expectedVersion: store.get("task_groups", group.id).version,
      status: "done",
    }),
    (error) => error.code === "task_group_incomplete",
  );
  store.addAcceptance({
    taskGroupId: group.id,
    scope: "requirement",
    scopeId: revision.id,
    criteria: ["survives restart"],
    result: "passed",
    evidenceIds: [evidence.id],
    verifiedByRunId: passedReviewRun.id,
  });
  const currentGroup = store.get("task_groups", group.id);
  assert.equal(store.updateTaskGroupStatus(group.id, {
    expectedVersion: currentGroup.version,
    status: "done",
  }).status, "done");
});

test("recovers stale runs, leases, locks, and ready work after restart", async (t) => {
  const { dbPath, store } = await fixture(t);
  const { group, revision, item } = graph(store);
  const worker = store.createWorkerSession({
    taskGroupId: group.id,
    workItemId: item.id,
    role: "worker",
    workspace: "/repo",
    status: "running",
    lastHeartbeatAt: "2026-08-11T00:00:00.000Z",
  });
  const run = store.createRun({
    workerSessionId: worker.id,
    workItemId: item.id,
    requirementRevisionId: revision.id,
    status: "running",
  });
  const runningItem = store.updateWorkItemStatus(item.id, {
    expectedVersion: item.version,
    status: "running",
  });
  store.acquireWorkItemLease({
    workItemId: item.id,
    workerSessionId: worker.id,
    now: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T00:10:00.000Z",
  });
  store.acquireResourceLock({
    resourceKey: "file:lib/team-store.mjs",
    taskGroupId: group.id,
    workItemId: item.id,
    workerSessionId: worker.id,
    now: "2026-08-11T00:00:00.000Z",
    expiresAt: "2026-08-11T00:10:00.000Z",
  });
  store.close();

  const reopened = await openTeamStore(dbPath);
  t.after(() => { try { reopened.close(); } catch {} });
  const result = reopened.recover({ staleBefore: "2026-08-11T00:05:00.000Z" });
  assert.deepEqual(result, { interruptedRuns: 1, readyWorkItems: [item.id] });
  assert.equal(reopened.get("runs", run.id).status, "interrupted");
  assert.equal(reopened.get("worker_sessions", worker.id).status, "lost");
  assert.equal(reopened.get("work_items", runningItem.id).status, "ready");
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM work_item_leases").get().count, 0);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM resource_locks").get().count, 0);
  assert.equal(reopened.get("evidence", "missing"), undefined);
  const recoveryEvents = reopened.db.prepare(`
    SELECT event_type FROM events
    WHERE event_type IN (
      'run.interrupted',
      'worker_session.status_changed',
      'work_item.status_changed'
    )
    ORDER BY id DESC LIMIT 3
  `).all().map((row) => row.event_type).sort();
  assert.deepEqual(recoveryEvents, [
    "run.interrupted",
    "work_item.status_changed",
    "worker_session.status_changed",
  ]);
  assert.equal(
    reopened.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events e JOIN outbox o ON o.event_id = e.id
      WHERE e.event_type IN (
        'run.interrupted',
        'worker_session.status_changed',
        'work_item.status_changed'
      )
    `).get().count >= 3,
    true,
  );
});

test("backs up before migration and restores a consistent database after migration failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-team-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "team.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE legacy_marker(value TEXT NOT NULL);
    INSERT INTO legacy_marker VALUES ('preserve-me');
    PRAGMA user_version = 0;
  `);
  legacy.close();
  let migrationError;
  await assert.rejects(
    () => openTeamStore(dbPath, {
      migrationHook: () => { throw new Error("injected migration failure"); },
    }),
    (error) => {
      migrationError = error;
      assert.equal(error instanceof TeamStoreMigrationError, true);
      assert.match(error.message, /injected migration failure/);
      assert.equal(fs.existsSync(error.backupPath), true);
      return true;
    },
  );
  assert.notEqual(fs.readFileSync(dbPath).length, 0);
  assert.equal(fs.readFileSync(migrationError.backupPath).length > 0, true);
  const restored = new DatabaseSync(dbPath);
  assert.equal(
    restored.prepare("SELECT value FROM legacy_marker").get().value,
    "preserve-me",
  );
  assert.equal(restored.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    restored.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'task_groups'").get().count,
    0,
  );
  restored.close();
});

test("creates and verifies an online backup containing task and event state", async (t) => {
  const { dir, store } = await fixture(t);
  graph(store);
  const backupPath = path.join(dir, "backups", "team.sqlite");
  const result = await store.createBackup(backupPath);
  assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.events > 0, true);
  assert.equal(result.outbox, result.events);
  assert.deepEqual(verifyTeamStoreBackup(backupPath), result);
  await assert.rejects(
    () => store.createBackup(backupPath),
    (error) => error.code === "backup_exists",
  );
});

test("returns taskboard summaries and hides worker details unless requested", async (t) => {
  const { store } = await fixture(t);
  const taskGroup = store.createTaskGroup({
    originThreadId: "thread-board",
    title: "Board",
    workspace: "/repo",
  });

  const summaries = store.listTaskGroups();
  assert.equal(summaries[0].id, taskGroup.id);
  assert.equal(summaries[0].progress, 0);
  assert.equal(summaries[0].running_workers, 0);
  assert.equal(summaries[0].demand_count, 0);

  const basic = store.getTaskGroupSnapshot(taskGroup.id);
  assert.equal(basic.id, taskGroup.id);
  assert.equal(basic.worker_sessions, undefined);
  assert.deepEqual(basic.work_items, []);

  const advanced = store.getTaskGroupSnapshot(taskGroup.id, { includeWorkers: true });
  assert.deepEqual(advanced.worker_sessions, []);
  assert.deepEqual(advanced.runs, []);
});

test("resolves exactly one active origin request for MCP demand binding", async (t) => {
  const { store } = await fixture(t);
  const group = store.createTaskGroup({
    originThreadId: "thread-active",
    title: "Active",
    workspace: "/repo",
  });
  store.recordExternalEvent({
    taskGroupId: group.id,
    aggregateType: "gateway",
    aggregateId: "request-active",
    eventType: "gateway.request_started",
    payload: { threadId: "thread-active" },
  });
  assert.deepEqual(store.resolveActiveConversation(), {
    taskGroupId: group.id,
    threadId: "thread-active",
    requestId: "request-active",
    startedAt: store.resolveActiveConversation().startedAt,
  });
  store.recordExternalEvent({
    taskGroupId: group.id,
    aggregateType: "gateway",
    aggregateId: "request-active",
    eventType: "gateway.request_completed",
  });
  assert.equal(store.resolveActiveConversation(), null);
});

test("resolves an active request within an explicit thread when other threads are active", async (t) => {
  const { store } = await fixture(t);
  const first = store.createTaskGroup({
    originThreadId: "thread-first",
    title: "First",
    workspace: "/first",
  });
  const second = store.createTaskGroup({
    originThreadId: "thread-second",
    title: "Second",
    workspace: "/second",
  });
  for (const [group, requestId] of [[first, "request-first"], [second, "request-second"]]) {
    store.recordExternalEvent({
      taskGroupId: group.id,
      aggregateType: "gateway",
      aggregateId: requestId,
      eventType: "gateway.request_started",
      payload: { threadId: group.origin_thread_id },
    });
  }

  assert.equal(store.resolveActiveConversation(), null);
  assert.deepEqual(
    {
      ...store.resolveActiveConversation("thread-first"),
      startedAt: undefined,
    },
    {
      taskGroupId: first.id,
      threadId: "thread-first",
      requestId: "request-first",
      startedAt: undefined,
    },
  );
});

test("schema v3 migrates Codex session data without loss", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-team-v1-v2-"));
  const dbPath = path.join(dir, "team.sqlite");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v1 = await openTeamStore(dbPath, { targetVersion: 1 });
  const timestamp = "2026-08-14T00:00:00.000Z";
  v1.db.prepare(`
    INSERT INTO task_groups(
      id, origin_thread_id, title, status, workspace, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tg-v1", "thread-v1", "Legacy", "executing", "/repo", 0, timestamp, timestamp);
  v1.db.prepare(`
    INSERT INTO worker_sessions(
      id, task_group_id, codex_thread_id, role, status, workspace,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ws-v1", "tg-v1", "codex-thread-v1", "worker", "running", "/repo", 0, timestamp, timestamp);
  v1.db.prepare(`
    INSERT INTO runs(
      id, worker_session_id, role, status, version, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("run-v1", "ws-v1", "worker", "running", 0, timestamp, timestamp, timestamp);
  v1.close();

  const v2 = await openTeamStore(dbPath);
  t.after(() => { try { v2.close(); } catch {} });
  const columns = v2.db.prepare("PRAGMA table_info(worker_sessions)").all().map((row) => row.name);
  assert.equal(columns.includes("codex_thread_id"), false);
  assert.equal(columns.includes("runtime_session_id"), true);
  assert.deepEqual(
    {
      ...v2.db.prepare(`
        SELECT runtime_kind, runtime_session_id, runtime_metadata
        FROM worker_sessions WHERE id = 'ws-v1'
      `).get(),
    },
    {
      runtime_kind: "codex",
      runtime_session_id: "codex-thread-v1",
      runtime_metadata: "{}",
    },
  );
  assert.equal(v2.get("task_groups", "tg-v1").runtime_kind, "codex");
  assert.equal(v2.get("runs", "run-v1").runtime_kind, "codex");
  assert.equal(v2.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual(
    v2.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => ({ ...row })),
    [{ version: 1 }, { version: 2 }, { version: 3 }],
  );
});

test("project runtime is strict, snapshotted, and switchable only while inactive", async (t) => {
  const { store } = await fixture(t);
  const codex = store.createTaskGroup({
    originThreadId: "runtime-codex",
    title: "Codex",
    workspace: "/repo",
  });
  const harness = store.createTaskGroup({
    originThreadId: "runtime-harness",
    title: "Harness",
    workspace: "/repo",
    runtimeKind: "deepseek-harness",
  });
  assert.equal(codex.runtime_kind, "codex");
  assert.equal(harness.runtime_kind, "deepseek-harness");
  assert.throws(
    () => store.createTaskGroup({
      originThreadId: "runtime-invalid",
      title: "Invalid",
      workspace: "/repo",
      runtimeKind: "harness",
    }),
    (error) => error instanceof TeamStoreError && error.code === "invalid_runtime_kind",
  );

  const codexWorker = store.createWorkerSession({
    taskGroupId: codex.id,
    runtimeSessionId: "shared-session",
    role: "worker",
    status: "idle",
    workspace: "/repo",
  });
  const harnessWorker = store.createWorkerSession({
    taskGroupId: harness.id,
    runtimeSessionId: "shared-session",
    role: "worker",
    status: "idle",
    workspace: "/repo",
  });
  const harnessRun = store.createRun({
    workerSessionId: harnessWorker.id,
    role: "worker",
    status: "queued",
  });
  assert.equal(codexWorker.runtime_kind, "codex");
  assert.equal(harnessWorker.runtime_kind, "deepseek-harness");
  assert.equal(harnessRun.runtime_kind, "deepseek-harness");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM conversation_bindings WHERE worker_session_id = ?")
      .get(codexWorker.id).count,
    1,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM conversation_bindings WHERE worker_session_id = ?")
      .get(harnessWorker.id).count,
    0,
  );

  const switched = store.changeTaskGroupRuntime(codex.id, {
    runtimeKind: "deepseek-harness",
  });
  assert.equal(switched.runtime_kind, "deepseek-harness");
  assert.equal(store.get("worker_sessions", codexWorker.id).runtime_kind, "codex");
  const executing = store.updateTaskGroupStatus(codex.id, {
    expectedVersion: switched.version,
    status: "executing",
  });
  assert.throws(
    () => store.changeTaskGroupRuntime(codex.id, { runtimeKind: "codex" }),
    (error) => error instanceof TeamStoreError
      && error.code === "runtime_switch_blocked"
      && error.taskGroupStatus === "executing",
  );
  store.updateTaskGroupStatus(codex.id, {
    expectedVersion: executing.version,
    status: "paused",
  });

  const active = store.createWorkerSession({
    taskGroupId: codex.id,
    role: "worker",
    status: "creating",
    workspace: "/repo",
  });
  assert.throws(
    () => store.changeTaskGroupRuntime(codex.id, { runtimeKind: "codex" }),
    (error) => error instanceof TeamStoreError
      && error.code === "runtime_switch_blocked"
      && error.activeWorkers === 1,
  );
  assert.equal(store.get("task_groups", codex.id).runtime_kind, "deepseek-harness");
  store.updateWorkerSessionStatus(active.id, {
    expectedVersion: active.version,
    status: "idle",
  });
  const activeRun = store.createRun({
    workerSessionId: active.id,
    role: "worker",
    status: "running",
  });
  assert.throws(
    () => store.changeTaskGroupRuntime(codex.id, { runtimeKind: "codex" }),
    (error) => error instanceof TeamStoreError
      && error.code === "runtime_switch_blocked"
      && error.activeRuns === 1,
  );
  assert.equal(store.get("runs", activeRun.id).runtime_kind, "deepseek-harness");
});
