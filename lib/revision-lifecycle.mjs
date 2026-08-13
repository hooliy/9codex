import {
  classifyWorkItemState,
  indexDependencyStatus,
  isTerminalWorkItem,
} from "./work-item-state.mjs";
import {
  auditWorkerSessions,
  finalizeWorkerIsolation,
  revokeWorkerSessions,
} from "./worker-lifecycle.mjs";

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function rows(store, sql, ...params) {
  return store.db.prepare(sql).all(...params);
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function retryableFrom(options, item) {
  if (typeof options.retryable === "function") return options.retryable(item);
  if (options.nonRetryableWorkItemIds) return !new Set(options.nonRetryableWorkItemIds).has(item?.id);
  return item?.status !== "blocked";
}

function dependencyMap(store, taskGroupId) {
  const result = new Map();
  for (const edge of rows(store, `
    SELECT d.* FROM work_item_dependencies d
    JOIN work_items wi ON wi.id = d.work_item_id
    WHERE wi.task_group_id = ?
  `, taskGroupId)) {
    const values = result.get(edge.work_item_id) || [];
    values.push(edge.depends_on_id);
    result.set(edge.work_item_id, values);
  }
  return result;
}

function parseWriteSet(item) {
  if (Array.isArray(item.write_set)) return item.write_set;
  try {
    const parsed = JSON.parse(item.write_set || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function lockConflictsByWorkItem(store, taskGroupId, workItems) {
  const locks = rows(
    store,
    "SELECT * FROM resource_locks WHERE task_group_id = ?",
    taskGroupId,
  );
  const result = new Map();
  for (const item of workItems) {
    const writeSet = new Set(parseWriteSet(item));
    if (writeSet.size === 0) continue;
    const conflicts = locks
      .filter((lock) => lock.work_item_id !== item.id && writeSet.has(lock.resource_key))
      .map((lock) => lock.resource_key);
    if (conflicts.length) result.set(item.id, conflicts);
  }
  return result;
}

function lockConflictsFor(options, persistedConflicts, item) {
  const conflicts = options.lockConflictsByWorkItem;
  if (!conflicts) return persistedConflicts.get(item.id) || [];
  return conflicts instanceof Map ? conflicts.get(item.id) || [] : conflicts[item.id] || [];
}

function projectedActiveRevisionIds(store, taskGroupId, revision) {
  const ids = rows(store, `
    SELECT rr.id, rr.requirement_id
    FROM requirement_revisions rr
    JOIN requirements requirement ON requirement.id = rr.requirement_id
    WHERE requirement.task_group_id = ? AND rr.status = 'active'
  `, taskGroupId)
    .filter((entry) => entry.requirement_id !== revision.requirement_id)
    .map((entry) => entry.id);
  ids.push(revision.id);
  return new Set(ids);
}

function activeWorkerIds(audit) {
  return new Set(audit.filter((entry) => entry.active && !entry.isolate).map((entry) => entry.workItemId));
}

function staleBefore(options, auditedAt) {
  if (options.staleBefore != null) return options.staleBefore;
  const timeout = Number(options.staleWorkerAfterMs ?? options.heartbeatTimeoutMs);
  if (!Number.isFinite(timeout) || timeout < 0) return null;
  return new Date(new Date(auditedAt).getTime() - timeout).toISOString();
}

export function auditRevisionLifecycle(options = {}) {
  const { store } = options;
  if (!store?.db) throw new TypeError("store is required");
  const revisionId = requireText(
    options.revisionId || options.requirementRevisionId,
    "revisionId",
  );
  const revision = store.get("requirement_revisions", revisionId);
  if (!revision) throw new Error(`RequirementRevision not found: ${revisionId}`);
  const requirement = store.get("requirements", revision.requirement_id);
  if (!requirement) throw new Error(`Requirement not found: ${revision.requirement_id}`);
  const taskGroup = store.get("task_groups", requirement.task_group_id);
  if (!taskGroup) throw new Error(`TaskGroup not found: ${requirement.task_group_id}`);
  const auditedAt = nowIso(options.now);
  const workItems = rows(store, "SELECT * FROM work_items WHERE task_group_id = ? ORDER BY created_at, id", taskGroup.id);
  const sessions = rows(store, "SELECT * FROM worker_sessions WHERE task_group_id = ? ORDER BY created_at, id", taskGroup.id);
  const runs = rows(store, `
    SELECT r.* FROM runs r
    JOIN worker_sessions ws ON ws.id = r.worker_session_id
    WHERE ws.task_group_id = ? ORDER BY r.created_at, r.id
  `, taskGroup.id);
  const currentRevisionIds = projectedActiveRevisionIds(store, taskGroup.id, revision);
  const workerAudit = auditWorkerSessions(sessions, {
    runs,
    workItems,
    currentRevisionId: revision.id,
    currentRevisionIds,
    staleSessionIds: options.staleSessionIds || [],
    staleBefore: staleBefore(options, auditedAt),
    retryable: (item) => retryableFrom(options, item),
  });
  const activeWorkers = activeWorkerIds(workerAudit);
  const dependencies = dependencyMap(store, taskGroup.id);
  const dependencyStatus = indexDependencyStatus(workItems);
  const lockConflicts = lockConflictsByWorkItem(store, taskGroup.id, workItems);
  const activeCount = workerAudit.filter((entry) => entry.active && !entry.isolate && entry.role === "worker").length;
  const configuredMaxWorkers = Number(options.maxWorkers ?? options.maxConcurrency ?? 3);
  const maxWorkers = Number.isFinite(configuredMaxWorkers)
    ? Math.max(1, Math.floor(configuredMaxWorkers))
    : 3;

  const workItemAudit = workItems
    .filter((item) => !isTerminalWorkItem(item))
    .map((item) => {
      const itemRevision = store.get("requirement_revisions", item.requirement_revision_id);
      return classifyWorkItemState(item, {
        currentRevisionId: revision.id,
        currentRevisionIds,
        revisionStatus: itemRevision?.status,
        dependencies: dependencies.get(item.id) || [],
        dependencyStatus,
        activeWorker: activeWorkers.has(item.id),
        hasCapacity: activeCount < maxWorkers,
        activeWorkers: activeCount,
        maxWorkers,
        lockConflicts: lockConflictsFor(options, lockConflicts, item),
        retryable: retryableFrom(options, item),
      });
    });

  return {
    schemaVersion: 1,
    auditedAt,
    taskGroupId: taskGroup.id,
    requirementId: requirement.id,
    currentRequirementRevisionId: revision.id,
    revision: revision.revision,
    previousCurrentRequirementRevisionId: taskGroup.current_requirement_revision_id || null,
    maxWorkers,
    activeWorkers: activeCount,
    workItems: workItemAudit,
    workers: workerAudit,
    counts: {
      nonTerminalWorkItems: workItemAudit.length,
      historicalWorkItems: workItemAudit.filter((entry) => entry.historical).length,
      runningWorkItems: workItemAudit.filter((entry) => entry.classification === "running").length,
      queuedWorkItems: workItemAudit.filter((entry) => ["backlog", "ready"].includes(entry.classification)).length,
      waitingWorkItems: workItemAudit.filter((entry) => Boolean(entry.waitingReason)).length,
      workersToIsolate: workerAudit.filter((entry) => entry.isolate).length,
    },
    waitingReasons: Object.fromEntries(workItemAudit
      .filter((entry) => entry.waitingReason)
      .map((entry) => [entry.workItemId, {
        reason: entry.waitingReason,
        basis: entry.waitingBasis,
      }])),
    isolationReasons: Object.fromEntries(workerAudit
      .filter((entry) => entry.isolate)
      .map((entry) => [entry.workerSessionId, {
        reason: entry.reason,
        basis: entry.waitingBasis,
      }])),
  };
}

function activateRevisionRows(store, audit, options = {}) {
  const timestamp = audit.auditedAt;
  return store.transaction(() => {
    store.db.prepare(`
      UPDATE requirement_revisions SET status = 'superseded'
      WHERE requirement_id = ? AND id <> ? AND status = 'active'
    `).run(audit.requirementId, audit.currentRequirementRevisionId);
    store.db.prepare(`
      UPDATE requirement_revisions SET status = 'active'
      WHERE id = ? AND requirement_id = ?
    `).run(audit.currentRequirementRevisionId, audit.requirementId);
    store.db.prepare(`
      UPDATE task_groups
      SET current_requirement_revision_id = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND current_requirement_revision_id IS NOT ?
    `).run(audit.currentRequirementRevisionId, timestamp, audit.taskGroupId, audit.currentRequirementRevisionId);

    for (const item of audit.workItems.filter((entry) => entry.historical)) {
      store.db.prepare(`
        UPDATE work_items SET status = 'stale', updated_at = ?, version = version + 1
        WHERE id = ? AND status NOT IN ('closed','stale','canceled')
      `).run(timestamp, item.workItemId);
    }

    store.recordExternalEvent({
      taskGroupId: audit.taskGroupId,
      aggregateType: "requirement_revision",
      aggregateId: audit.currentRequirementRevisionId,
      eventType: "requirement_revision.activated",
      payload: {
        previousRevisionId: audit.previousCurrentRequirementRevisionId,
        revision: audit.revision,
        historicalWorkItemIds: audit.workItems.filter((entry) => entry.historical).map((entry) => entry.workItemId),
        actor: options.actor || "revision_lifecycle",
        source: options.source || "revision_lifecycle",
      },
    });
    store.recordExternalEvent({
      taskGroupId: audit.taskGroupId,
      aggregateType: "requirement_revision",
      aggregateId: audit.currentRequirementRevisionId,
      eventType: "revision_lifecycle.audit_recorded",
      payload: {
        audit,
        actor: options.actor || "revision_lifecycle",
        source: options.source || "revision_lifecycle",
      },
    });
    return revokeWorkerSessions({
      store,
      candidates: audit.workers,
      now: timestamp,
      actor: options.actor,
      source: options.source,
    });
  });
}

export async function activateRequirementRevision(options = {}) {
  const audit = auditRevisionLifecycle(options);
  const revokedWorkers = activateRevisionRows(options.store, audit, options);
  const isolatedWorkers = await finalizeWorkerIsolation({
    isolated: revokedWorkers,
    adapter: options.adapter,
    runtime: options.runtime,
    workspaceManager: options.workspaceManager,
  });
  return {
    revision: options.store.get("requirement_revisions", audit.currentRequirementRevisionId),
    audit,
    isolatedWorkers,
  };
}

export async function createAndActivateRequirementRevision(options = {}) {
  const { store } = options;
  if (!store?.addRequirementRevision) throw new TypeError("store is required");
  const requirementId = requireText(options.requirementId, "requirementId");
  const requirement = store.get("requirements", requirementId);
  if (!requirement) throw new Error(`Requirement not found: ${requirementId}`);
  const taskGroup = store.get("task_groups", requirement.task_group_id);
  if (!taskGroup) throw new Error(`TaskGroup not found: ${requirement.task_group_id}`);
  const previousRevisionId = taskGroup.current_requirement_revision_id || null;

  // addRequirementRevision historically activates immediately. Enclosing both
  // creation and reconciliation in one outer transaction prevents a partially
  // created/current revision when auditing or durable worker revocation fails.
  const prepared = store.transaction(() => {
    const revision = store.addRequirementRevision({
      requirementId,
      sourceMessageId: requireText(options.sourceMessageId, "sourceMessageId"),
      normalizedRequirement: requireText(options.normalizedRequirement, "normalizedRequirement"),
      acceptanceCriteria: options.acceptanceCriteria || [],
      impactSummary: options.impactSummary ?? null,
      revision: options.revision,
      id: options.id,
    });
    const audit = auditRevisionLifecycle({ ...options, revisionId: revision.id });
    audit.previousCurrentRequirementRevisionId = previousRevisionId;
    const revokedWorkers = activateRevisionRows(store, audit, options);
    return { audit, revokedWorkers };
  });
  const isolatedWorkers = await finalizeWorkerIsolation({
    isolated: prepared.revokedWorkers,
    adapter: options.adapter,
    runtime: options.runtime,
    workspaceManager: options.workspaceManager,
  });
  return {
    revision: store.get("requirement_revisions", prepared.audit.currentRequirementRevisionId),
    audit: prepared.audit,
    isolatedWorkers,
  };
}

export class RevisionLifecycleCoordinator {
  constructor(options = {}) {
    if (!options.store) throw new TypeError("store is required");
    this.options = { ...options };
  }

  audit(input = {}) {
    return auditRevisionLifecycle({ ...this.options, ...input });
  }

  activate(input = {}) {
    return activateRequirementRevision({ ...this.options, ...input });
  }

  createAndActivate(input = {}) {
    return createAndActivateRequirementRevision({ ...this.options, ...input });
  }
}

export function createRevisionLifecycleCoordinator(options) {
  return new RevisionLifecycleCoordinator(options);
}

export const reconcileRevisionLifecycle = activateRequirementRevision;
