const TERMINAL_STATUSES = new Set(["closed", "stale", "canceled"]);
const QUEUED_STATUSES = new Set(["backlog", "ready", "rework"]);
const EXECUTING_STATUSES = new Set(["assigned", "running"]);
const ACCEPTANCE_STATUSES = new Set(["reported", "verifying", "revalidate", "passed"]);
const FAILED_STATUSES = new Set(["failed", "blocked"]);

function asSet(values = []) {
  return values instanceof Set ? values : new Set(values);
}

function dependencyIds(input) {
  return input.dependencies || input.dependencyIds || input.dependency_ids || [];
}

/**
 * Classifies a persisted work item without changing it.
 *
 * The result deliberately separates the durable status from the operational
 * classification used by revision activation. This prevents a historical
 * `ready` item from being mistaken for runnable work merely because its local
 * status still says ready.
 */
export function classifyWorkItemState(item, context = {}) {
  if (!item?.id) throw new TypeError("work item is required");
  const currentRevisionId = context.currentRevisionId || context.current_revision_id || null;
  const currentRevisionIds = context.currentRevisionIds || context.current_revision_ids || null;
  const itemRevisionId = item.requirement_revision_id || item.requirementRevisionId || null;
  const historical = currentRevisionIds
    ? !asSet(currentRevisionIds).has(itemRevisionId)
    : Boolean(currentRevisionId && itemRevisionId !== currentRevisionId);
  const revisionStatus = context.revisionStatus || context.revision_status || null;
  const terminal = TERMINAL_STATUSES.has(item.status);
  const dependencyStatus = context.dependencyStatus || context.dependency_status || new Map();
  const unmetDependencies = dependencyIds(context).filter((id) => {
    const status = dependencyStatus instanceof Map ? dependencyStatus.get(id) : dependencyStatus[id];
    return status !== "closed";
  });
  const activeWorker = Boolean(context.activeWorker);
  const hasCapacity = context.hasCapacity !== false;
  const lockConflicts = [...(context.lockConflicts || context.lock_conflicts || [])];

  let classification;
  let waitingReason = null;
  let runnable = false;
  let waitingBasis = null;

  if (terminal) {
    classification = "terminal";
  } else if (historical || revisionStatus === "superseded") {
    classification = "historical_revision";
    waitingReason = "requirement_revision_superseded";
    waitingBasis = {
      requirementRevisionId: itemRevisionId,
      currentRequirementRevisionId: currentRevisionId,
      revisionStatus,
    };
  } else if (EXECUTING_STATUSES.has(item.status) && activeWorker) {
    classification = "running";
  } else if (EXECUTING_STATUSES.has(item.status)) {
    classification = "orphaned_execution";
    waitingReason = "worker_missing";
    waitingBasis = { activeWorker: false };
  } else if (ACCEPTANCE_STATUSES.has(item.status)) {
    classification = "acceptance_wait";
    waitingReason = "independent_acceptance";
    waitingBasis = { status: item.status };
  } else if (FAILED_STATUSES.has(item.status)) {
    classification = context.retryable === false ? "failed_non_retryable" : "rework_wait";
    waitingReason = context.retryable === false ? "retry_forbidden" : "failure_requires_rework";
    waitingBasis = { status: item.status, retryable: context.retryable !== false };
  } else if (QUEUED_STATUSES.has(item.status) && unmetDependencies.length) {
    classification = "dependency_wait";
    waitingReason = "dependencies_incomplete";
    waitingBasis = { unmetDependencies };
  } else if (QUEUED_STATUSES.has(item.status) && lockConflicts.length) {
    classification = "lock_wait";
    waitingReason = "resource_or_workspace_lock";
    waitingBasis = { lockConflicts };
  } else if (QUEUED_STATUSES.has(item.status) && !hasCapacity) {
    classification = "capacity_wait";
    waitingReason = "worker_capacity";
    waitingBasis = { activeWorkers: context.activeWorkers ?? null, maxWorkers: context.maxWorkers ?? null };
  } else if (QUEUED_STATUSES.has(item.status)) {
    classification = item.status === "backlog" ? "backlog" : "ready";
    waitingReason = item.status === "backlog" ? "planning_or_priority" : "ready_for_worker";
    runnable = item.status !== "backlog";
    waitingBasis = { status: item.status };
  } else {
    classification = "unknown_non_terminal";
    waitingReason = "state_requires_audit";
    waitingBasis = { status: item.status };
  }

  return {
    workItemId: item.id,
    requirementRevisionId: itemRevisionId,
    status: item.status,
    classification,
    terminal,
    historical,
    runnable,
    activeWorker,
    waitingReason,
    waitingBasis,
    unmetDependencies,
    lockConflicts,
  };
}

export function isTerminalWorkItem(itemOrStatus) {
  return TERMINAL_STATUSES.has(typeof itemOrStatus === "string" ? itemOrStatus : itemOrStatus?.status);
}

export function indexDependencyStatus(items = []) {
  return new Map(items.map((item) => [item.id, item.status]));
}

export function activeWorkItemIds(items = []) {
  return asSet(items.filter((item) => !isTerminalWorkItem(item)).map((item) => item.id));
}

export const WORK_ITEM_STATE = Object.freeze({
  terminalStatuses: Object.freeze([...TERMINAL_STATUSES]),
  queuedStatuses: Object.freeze([...QUEUED_STATUSES]),
  executingStatuses: Object.freeze([...EXECUTING_STATUSES]),
  acceptanceStatuses: Object.freeze([...ACCEPTANCE_STATUSES]),
  failedStatuses: Object.freeze([...FAILED_STATUSES]),
});
