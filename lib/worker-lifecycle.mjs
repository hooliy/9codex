const ACTIVE_SESSION_STATUSES = new Set(["creating", "running", "waiting", "closing"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

export function isActiveWorkerSession(session) {
  return Boolean(session && ACTIVE_SESSION_STATUSES.has(session.status));
}

export function classifyWorkerLifecycle(session, context = {}) {
  if (!session?.id) throw new TypeError("worker session is required");
  const run = context.run || null;
  const item = context.workItem || context.work_item || null;
  const currentRevisionId = context.currentRevisionId || context.current_revision_id || null;
  const currentRevisionIds = context.currentRevisionIds || context.current_revision_ids || null;
  const runRevisionId = run?.requirement_revision_id || run?.requirementRevisionId || null;
  const itemRevisionId = item?.requirement_revision_id || item?.requirementRevisionId || null;
  const workerRevisionId = runRevisionId || itemRevisionId;
  const sessionWorkItemId = session.work_item_id || session.workItemId || null;
  const runWorkItemId = run?.work_item_id || run?.workItemId || null;
  const missingWorkItem = Boolean(sessionWorkItemId && !item);
  const workItemMismatch = Boolean(
    runWorkItemId
    && sessionWorkItemId
    && runWorkItemId !== sessionWorkItemId,
  );
  const revisionMismatch = Boolean(
    runRevisionId
    && itemRevisionId
    && runRevisionId !== itemRevisionId,
  );
  const historical = currentRevisionIds
    ? Boolean(workerRevisionId && !new Set(currentRevisionIds).has(workerRevisionId))
    : Boolean(currentRevisionId && workerRevisionId && workerRevisionId !== currentRevisionId);
  const staleHeartbeat = Boolean(context.staleHeartbeat || context.stale_heartbeat);
  const nonRetryableFailure = ["failed", "blocked"].includes(item?.status) && context.retryable === false;
  const invalidWork = ["stale", "canceled"].includes(item?.status);
  const active = isActiveWorkerSession(session) || ACTIVE_RUN_STATUSES.has(run?.status);
  const revocable = !["closed", "interrupted"].includes(session.status) || active;

  let classification = active ? "current_active" : "inactive";
  let isolate = false;
  let reason = null;
  if (session.status === "closed" && active) {
    classification = "closed_session_with_active_run";
    isolate = true;
    reason = "closed_session_has_active_run";
  } else if (missingWorkItem) {
    classification = "orphaned_work_item";
    isolate = revocable;
    reason = "work_item_missing_or_outside_task_group";
  } else if (workItemMismatch || revisionMismatch) {
    classification = "worker_association_mismatch";
    isolate = revocable;
    reason = workItemMismatch ? "run_work_item_mismatch" : "run_revision_mismatch";
  } else if (historical) {
    classification = "superseded_revision";
    isolate = revocable;
    reason = "requirement_revision_superseded";
  } else if (invalidWork) {
    classification = `work_item_${item.status}`;
    isolate = revocable;
    reason = `work_item_${item.status}`;
  } else if (nonRetryableFailure) {
    classification = "failed_non_retryable";
    isolate = revocable;
    reason = "retry_forbidden";
  } else if (staleHeartbeat && active) {
    classification = "stale_worker";
    isolate = true;
    reason = "stale_heartbeat";
  } else if (active && !run) {
    classification = "orphaned_session";
    isolate = true;
    reason = "running_session_without_run";
  }

  return {
    workerSessionId: session.id,
    workItemId: sessionWorkItemId,
    runId: run?.id || null,
    role: session.role,
    status: session.status,
    runStatus: run?.status || null,
    classification,
    historical,
    active,
    waitingBasis: reason ? {
      reason,
      currentRequirementRevisionId: currentRevisionId,
      workerRequirementRevisionId: workerRevisionId,
      lastHeartbeatAt: session.last_heartbeat_at || null,
    } : null,
    isolate,
    reason,
    missingWorkItem,
    workItemMismatch,
    revisionMismatch,
  };
}

function latestRunsBySession(runs = []) {
  const result = new Map();
  for (const run of runs) {
    const prior = result.get(run.worker_session_id);
    if (!prior || String(run.created_at || run.id) > String(prior.created_at || prior.id)) {
      result.set(run.worker_session_id, run);
    }
  }
  return result;
}

export function auditWorkerSessions(sessions = [], context = {}) {
  const runs = latestRunsBySession(context.runs || []);
  const workItems = new Map((context.workItems || context.work_items || []).map((item) => [item.id, item]));
  const staleSessionIds = new Set(context.staleSessionIds || context.stale_session_ids || []);
  const staleBefore = context.staleBefore || context.stale_before;
  const staleBeforeMs = staleBefore == null ? null : new Date(staleBefore).getTime();
  if (Number.isFinite(staleBeforeMs)) {
    for (const session of sessions) {
      const heartbeatMs = session.last_heartbeat_at == null
        ? Number.NaN
        : new Date(session.last_heartbeat_at).getTime();
      if (isActiveWorkerSession(session) && (!Number.isFinite(heartbeatMs) || heartbeatMs < staleBeforeMs)) {
        staleSessionIds.add(session.id);
      }
    }
  }
  const retryable = context.retryable || (() => true);
  return sessions.map((session) => classifyWorkerLifecycle(session, {
    currentRevisionId: context.currentRevisionId,
    currentRevisionIds: context.currentRevisionIds,
    run: runs.get(session.id) || null,
    workItem: workItems.get(session.work_item_id || session.workItemId) || null,
    staleHeartbeat: staleSessionIds.has(session.id),
    retryable: retryable(workItems.get(session.work_item_id || session.workItemId), session),
  }));
}

/**
 * Durably revokes the database-side authority of selected workers.
 * Process interruption happens after the transaction, so a process that is
 * slow to terminate has already lost its run, lease, lock, and schedulability.
 */
function nowIso(now) {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function revokeWorkerSessions(options = {}) {
  const { store } = options;
  if (!store?.db || typeof store.transaction !== "function") throw new TypeError("store is required");
  const candidates = (options.candidates || []).filter((entry) => entry?.isolate);
  const timestamp = nowIso(options.now);
  const isolated = [];

  store.transaction(() => {
    for (const candidate of candidates) {
      const session = store.get("worker_sessions", candidate.workerSessionId);
      if (!session) continue;
      const runningRuns = store.db.prepare(
        "SELECT * FROM runs WHERE worker_session_id = ? AND status IN ('queued','running')",
      ).all(session.id);
      for (const run of runningRuns) {
        store.db.prepare(`
          UPDATE runs SET status = 'interrupted', ended_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND status IN ('queued','running')
        `).run(timestamp, timestamp, run.id);
      }
      if (session.status !== "closed") {
        store.db.prepare(`
          UPDATE worker_sessions
          SET status = 'interrupted', closed_at = COALESCE(closed_at, ?),
              updated_at = ?, version = version + 1
          WHERE id = ? AND status <> 'closed'
        `).run(timestamp, timestamp, session.id);
      }
      store.db.prepare("DELETE FROM work_item_leases WHERE worker_session_id = ?").run(session.id);
      store.db.prepare("DELETE FROM resource_locks WHERE worker_session_id = ?").run(session.id);
      store.recordExternalEvent({
        taskGroupId: session.task_group_id,
        aggregateType: "worker_session",
        aggregateId: session.id,
        eventType: "worker_session.isolated",
        payload: {
          reason: candidate.reason || "revision_lifecycle_isolation",
          classification: candidate.classification,
          workItemId: session.work_item_id,
          runIds: runningRuns.map((run) => run.id),
          actor: options.actor || "revision_lifecycle",
          source: options.source || "worker_lifecycle",
        },
      });
      isolated.push({
        workerSessionId: session.id,
        workItemId: session.work_item_id,
        reason: candidate.reason,
        runIds: runningRuns.map((run) => run.id),
      });
    }
  });
  return isolated;
}

export async function finalizeWorkerIsolation(options = {}) {
  const isolated = options.isolated || [];
  for (const entry of isolated) {
    const runtime = options.runtime?.get?.(entry.workerSessionId);
    if (runtime?.worker && options.adapter?.interruptWorker) {
      try { await options.adapter.interruptWorker(runtime.worker); } catch {}
    }
    options.runtime?.delete?.(entry.workerSessionId);
    if (entry.workItemId) {
      try { options.workspaceManager?.release?.(entry.workItemId); } catch {}
    }
  }
  return isolated;
}

export async function isolateWorkerSessions(options = {}) {
  const isolated = revokeWorkerSessions(options);
  return finalizeWorkerIsolation({ ...options, isolated });
}

export const WORKER_LIFECYCLE = Object.freeze({
  activeSessionStatuses: Object.freeze([...ACTIVE_SESSION_STATUSES]),
  activeRunStatuses: Object.freeze([...ACTIVE_RUN_STATUSES]),
});
