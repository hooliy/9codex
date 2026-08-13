import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runVerification } from "./verification-runner.mjs";

const ACTIVE_GROUP_STATUSES = new Set(["planning", "executing", "integrating", "verifying"]);
const ACTIVE_SESSION_STATUSES = new Set(["creating", "running", "waiting", "closing"]);
const ACTIVE_WORK_STATUSES = new Set(["assigned", "running", "reported", "verifying"]);
const TERMINAL_WORK_STATUSES = new Set(["closed", "stale", "canceled"]);
const HIGH_IMPACT = /\b(delete|replace|remove|drop|public api|schema|migration|production|deploy|payment|paid|irreversible|cancel)\b|删除|替换|移除|公共\s*API|数据结构|数据库|迁移|生产|付费|不可逆|取消/i;
const MUTATING_DEMAND_TYPES = new Set([
  "new_requirement",
  "bug_report",
  "acceptance_feedback",
  "priority_change",
  "requirement_change",
]);
const EXPLICIT_EXECUTION = /(?:立即|马上|直接|现在)(?:开始)?(?:实现|修复|执行|改|做)|无需(?:再次)?确认|不要(?:再次)?确认|开始执行|执行以上|按以上.*执行/i;
const SHORT_APPROVAL = /^(?:approve|approved|ok|okay|yes|go|确认|确认执行|同意|批准|可以|可以执行|执行吧|好|好的|行|没问题)[。！!，,\s]*$/i;
const DISCUSSION = /(?:先讨论|讨论一下|讨论方案|方案怎么|如何设计|应该怎么|你觉得|是否应该|是不是应该|可不可以先|先别执行|暂不执行)/i;

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function safeSegment(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "") || "work";
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function defaultClassifier({ content, hasRequirements, taskGroup }) {
  const text = String(content).trim();
  const exact = text.toLowerCase();
  let type = "new_requirement";
  let confidence = 0.82;
  if (/^(pause|暂停|先停|停一下)\b/i.test(text)) ({ type, confidence } = { type: "pause", confidence: 0.99 });
  else if (/^(resume|继续|恢复)\b/i.test(text)) ({ type, confidence } = { type: "resume", confidence: 0.99 });
  else if (/^(cancel|取消|终止)\b/i.test(text)) ({ type, confidence } = { type: "cancel", confidence: 0.99 });
  else if (
    taskGroup?.status === "awaiting_confirmation"
    && (
      SHORT_APPROVAL.test(exact)
      || /^(?:approve|approved|确认|同意|批准|可以执行|执行吧|好|好的)(?:\s|[，。！!：:]|$)/i.test(text)
    )
  ) ({ type, confidence } = { type: "approval", confidence: 0.99 });
  else if (SHORT_APPROVAL.test(exact)) ({ type, confidence } = { type: "clarification", confidence: 0.99 });
  else if (DISCUSSION.test(text) && !EXPLICIT_EXECUTION.test(text)) ({ type, confidence } = { type: "clarification", confidence: 0.92 });
  else if (/bug|报错|错误|修复|fix/i.test(text)) ({ type, confidence } = { type: "bug_report", confidence: 0.88 });
  else if (/验收|反馈|不符合|acceptance|feedback/i.test(text)) ({ type, confidence } = { type: "acceptance_feedback", confidence: 0.86 });
  else if (/优先级|priority/i.test(text)) ({ type, confidence } = { type: "priority_change", confidence: 0.85 });
  else if (hasRequirements && /修改|改成|调整|新增|补充|change|update|instead/i.test(text)) ({ type, confidence } = { type: "requirement_change", confidence: 0.78 });
  const highImpact = HIGH_IMPACT.test(text);
  const executeImmediately = MUTATING_DEMAND_TYPES.has(type) && EXPLICIT_EXECUTION.test(text);
  return {
    type,
    confidence: highImpact ? Math.min(confidence, 0.6) : confidence,
    highImpact,
    executeImmediately,
    requiresConfirmation: MUTATING_DEMAND_TYPES.has(type) && !executeImmediately,
  };
}

function defaultPlanner({ content, classification, currentRequirement }) {
  const normalized = String(content).trim();
  return {
    requirement: {
      title: currentRequirement?.title || normalized.split(/\r?\n/, 1)[0].slice(0, 80) || "Requirement",
      normalizedRequirement: normalized,
      acceptanceCriteria: [{ id: "project-tests", command: ["npm", "test"] }],
      impactSummary: classification.type === "new_requirement" ? "new requirement" : "existing requirement changed",
    },
    workItems: [{
      key: "implementation",
      title: normalized.split(/\r?\n/, 1)[0].slice(0, 100) || "Implement requirement",
      description: normalized,
      writeSet: ["**"],
      readSet: [],
      resourceLocks: [],
      acceptanceCriteria: [{ id: "project-tests", command: ["npm", "test"] }],
      dependencies: [],
    }],
  };
}

function metadata(item) {
  if (!item?.description) return { description: "", readSet: [], resourceLocks: [] };
  try {
    const parsed = JSON.parse(item.description);
    if (parsed && parsed.__orchestrator === 1) return parsed;
  } catch {}
  return { description: item.description, readSet: [], resourceLocks: [] };
}

function criteriaForVerification(criteria) {
  const valid = (criteria || []).filter((criterion) => (
    criterion && typeof criterion.id === "string" && Array.isArray(criterion.command) && criterion.command.length
  ));
  return valid.length ? valid : [{ id: "project-tests", command: ["npm", "test"] }];
}

export class TaskOrchestrator {
  constructor(options = {}) {
    if (!options.store) throw new TypeError("store is required");
    if (!options.adapter) throw new TypeError("adapter is required");
    if (!options.workspaceManager) throw new TypeError("workspaceManager is required");
    this.store = options.store;
    this.adapter = options.adapter;
    this.workspaceManager = options.workspaceManager;
    this.classifier = options.classifier || defaultClassifier;
    this.planner = options.planner || defaultPlanner;
    this.verificationRunner = options.verificationRunner || runVerification;
    this.maxConcurrency = Math.min(20, Math.max(1, options.maxConcurrency ?? 3));
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.verificationSecrets = options.verificationSecrets || [];
    this.verificationEnv = options.verificationEnv || process.env;
    this.onWorkerEvent = options.onWorkerEvent || (() => {});
    this.workerOptions = options.workerOptions || {};
    this.contextRotateAtTokens = options.contextRotateAtTokens || 800_000;
    this.now = options.now || (() => new Date());
    this.artifactRoot = options.artifactRoot || path.join(path.dirname(this.store.path), "artifacts");
    this.runtime = new Map();
    this.inflightDemands = new Map();
  }

  async ingestDemand(input) {
    const threadId = requireText(input?.threadId, "threadId");
    const sourceMessageId = requireText(input?.sourceMessageId, "sourceMessageId");
    const content = requireText(input?.content, "content");
    const workspace = input.workspace || process.cwd();
    const eventKey = input.eventKey || `${threadId}:${sourceMessageId}`;
    if (this.inflightDemands.has(eventKey)) return this.inflightDemands.get(eventKey);
    const operation = this.#ingestDemand({ ...input, threadId, sourceMessageId, content, workspace, eventKey });
    this.inflightDemands.set(eventKey, operation);
    try {
      return await operation;
    } finally {
      this.inflightDemands.delete(eventKey);
    }
  }

  async #ingestDemand(input) {
    const { threadId, sourceMessageId, content, workspace, eventKey } = input;
    let group = this.store.getTaskGroupByThread(threadId);
    if (!group) group = this.store.createTaskGroup({
      originThreadId: threadId,
      title: input.title || content.split(/\r?\n/, 1)[0].slice(0, 100),
      workspace,
    });
    else if (input.workspace && group.workspace !== workspace) {
      const hasWork = Number(this.store.db.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE task_group_id = ?",
      ).get(group.id).count) > 0;
      if (!hasWork && ["collecting", "awaiting_confirmation"].includes(group.status)) {
        group = this.store.updateTaskGroupWorkspace(group.id, {
          workspace,
          expectedVersion: group.version,
        });
      }
    }
    const existing = this.store.db.prepare("SELECT result_json FROM demand_events WHERE event_key = ?").get(eventKey);
    if (existing?.result_json) return JSON.parse(existing.result_json);

    const hasRequirements = Number(this.store.db.prepare(
      "SELECT COUNT(*) AS count FROM requirements WHERE task_group_id = ?",
    ).get(group.id).count) > 0;
    const rawClassification = await this.classifier({ content, taskGroup: group, hasRequirements, input });
    const classification = typeof rawClassification === "string"
      ? { type: rawClassification, confidence: 1, highImpact: HIGH_IMPACT.test(content) }
      : {
          type: rawClassification?.type || "new_requirement",
          confidence: rawClassification?.confidence ?? 0.5,
          highImpact: rawClassification?.highImpact ?? HIGH_IMPACT.test(content),
          ...rawClassification,
        };
    const appended = this.store.appendDemandEvent({
      eventKey,
      taskGroupId: group.id,
      sourceMessageId,
      rawContent: content,
      classifiedType: classification.type,
      classificationConfidence: classification.confidence,
    });
    if (!appended.created && appended.event.result_json) return appended.event.result_json;

    let result;
    const requiresConfirmation = classification.requiresConfirmation ?? (
      !["approval", "pause", "resume", "cancel", "clarification"].includes(classification.type) && (
        !hasRequirements
        || classification.highImpact && classification.confidence < 0.75
      )
    );
    if (requiresConfirmation) {
      const currentRequirement = this.store.db.prepare(`
        SELECT * FROM requirements WHERE task_group_id = ? AND status <> 'canceled'
        ORDER BY created_at DESC LIMIT 1
      `).get(group.id);
      const preview = await this.planner({
        content,
        classification,
        taskGroup: group,
        currentRequirement,
        existingWorkItems: this.#activeWorkItems(group.id),
      });
      this.#setGroupStatus(group.id, "awaiting_confirmation", "high_impact_low_confidence");
      result = {
        eventKey,
        taskGroupId: group.id,
        status: "awaiting_confirmation",
        classification,
        change: content,
        affectedWorkItems: this.#activeWorkItems(group.id).map((item) => item.id),
        proposedRequirement: preview?.requirement || null,
        proposedWorkItems: (preview?.workItems || []).map((item) => ({
          key: item.key,
          title: item.title,
          dependencies: item.dependencies || [],
          writeSet: item.writeSet || [],
          acceptanceCriteria: item.acceptanceCriteria || [],
        })),
      };
    } else if (classification.type === "approval") {
      const pending = this.#pendingConfirmation(group.id);
      result = pending
        ? await this.confirmDemand({ eventKey: pending.event_key, approved: true, approvalSourceMessageId: sourceMessageId })
        : { eventKey, taskGroupId: group.id, status: group.status, classification, noPendingConfirmation: true };
    } else {
      result = await this.#processDemand({ group, sourceMessageId, content, classification, eventKey });
    }
    this.#finishDemand(eventKey, result);
    return result;
  }

  async confirmDemand(input) {
    const eventKey = requireText(input?.eventKey, "eventKey");
    const event = this.store.db.prepare("SELECT * FROM demand_events WHERE event_key = ?").get(eventKey);
    if (!event) throw new Error(`DemandEvent not found: ${eventKey}`);
    const prior = event.result_json ? JSON.parse(event.result_json) : null;
    if (prior?.status !== "awaiting_confirmation") return prior;
    if (input.approved === false) {
      const result = { ...prior, status: "rejected" };
      this.#setGroupStatus(event.task_group_id, "collecting", "change_rejected");
      this.#finishDemand(eventKey, result);
      return result;
    }
    const group = this.store.get("task_groups", event.task_group_id);
    const classification = {
      type: input.classificationType || event.classified_type,
      confidence: 1,
      highImpact: true,
      corrected: Boolean(input.classificationType),
    };
    if (input.classificationType && input.classificationType !== event.classified_type) {
      this.store.recordExternalEvent({
        taskGroupId: event.task_group_id,
        aggregateType: "demand_event",
        aggregateId: event.id,
        eventType: "demand_event.classification_corrected",
        payload: {
          actor: "user",
          source: input.approvalSourceMessageId || event.source_message_id,
          from: event.classified_type,
          to: input.classificationType,
        },
      });
    }
    const result = await this.#processDemand({
      group,
      sourceMessageId: event.source_message_id,
      content: event.raw_content,
      classification,
      eventKey,
    });
    result.confirmed = true;
    if (input.approvalSourceMessageId) result.approvalSourceMessageId = input.approvalSourceMessageId;
    this.#finishDemand(eventKey, result);
    return result;
  }

  async #processDemand({ group, sourceMessageId, content, classification, eventKey }) {
    if (classification.type === "pause") return { eventKey, taskGroupId: group.id, classification, ...(await this.pause(group.id)) };
    if (classification.type === "resume") return { eventKey, taskGroupId: group.id, classification, ...(await this.resume(group.id)) };
    if (classification.type === "cancel") return { eventKey, taskGroupId: group.id, classification, ...(await this.cancel(group.id)) };
    if (classification.type === "clarification") {
      return {
        eventKey,
        taskGroupId: group.id,
        status: group.status,
        classification,
        discussion: true,
        workItems: [],
      };
    }
    if (group.status === "done") this.#setGroupStatus(group.id, "collecting", "new_demand_reopens_group");
    this.#setGroupStatus(group.id, "planning", "demand_processed");

    const currentRequirement = classification.requirementId
      ? this.store.get("requirements", classification.requirementId)
      : this.store.db.prepare(`
          SELECT * FROM requirements WHERE task_group_id = ? AND status <> 'canceled'
          ORDER BY created_at DESC LIMIT 1
        `).get(group.id);
    let plan;
    try {
      plan = await this.planner({
        content,
        classification,
        taskGroup: this.store.get("task_groups", group.id),
        currentRequirement,
        existingWorkItems: this.#activeWorkItems(group.id),
      });
    } catch (error) {
      this.#setGroupStatus(group.id, "collecting", "planning_failed");
      throw error;
    }
    const requirementPlan = plan?.requirement || {};
    const createsRequirement = classification.type === "new_requirement" || !currentRequirement;
    const requirement = createsRequirement
      ? this.store.createRequirement({
          taskGroupId: group.id,
          title: requirementPlan.title || content.slice(0, 80),
        })
      : currentRequirement;

    const oldRevision = this.store.db.prepare(`
      SELECT * FROM requirement_revisions WHERE requirement_id = ? AND status = 'active'
    `).get(requirement.id);
    const revision = this.store.addRequirementRevision({
      requirementId: requirement.id,
      sourceMessageId,
      normalizedRequirement: requirementPlan.normalizedRequirement || content,
      acceptanceCriteria: requirementPlan.acceptanceCriteria || [],
      impactSummary: requirementPlan.impactSummary || null,
    });
    const affectedWorkItems = oldRevision
      ? await this.#supersedeAffectedWork(oldRevision.id, plan?.impactActions || {})
      : [];
    const workItems = this.#createDag(group.id, revision.id, plan?.workItems || []);
    this.#setGroupStatus(group.id, "executing", "plan_ready");
    return {
      eventKey,
      taskGroupId: group.id,
      status: "executing",
      classification,
      requirementId: requirement.id,
      requirementRevisionId: revision.id,
      revision: revision.revision,
      affectedWorkItems,
      workItems: workItems.map((item) => item.id),
      executionOrder: workItems.map((item) => item.id),
    };
  }

  #createDag(taskGroupId, requirementRevisionId, plannedItems) {
    const plans = plannedItems.length ? plannedItems : defaultPlanner({ content: "Implement requirement", classification: {}, currentRequirement: null }).workItems;
    const byKey = new Map();
    const records = [];
    for (const [index, plan] of plans.entries()) {
      const key = plan.key || `work-${index + 1}`;
      if (byKey.has(key)) throw new Error(`duplicate work item key: ${key}`);
      const description = JSON.stringify({
        __orchestrator: 1,
        description: plan.description || "",
        readSet: plan.readSet || [],
        resourceLocks: plan.resourceLocks || [],
        key,
      });
      const record = this.store.createWorkItem({
        taskGroupId,
        requirementRevisionId,
        title: requireText(plan.title || key, "work item title"),
        description,
        status: "ready",
        priority: plan.priority ?? 0,
        writeSet: plan.writeSet || [],
        acceptanceCriteria: plan.acceptanceCriteria || [],
      });
      byKey.set(key, record);
      records.push(record);
    }
    for (const [index, plan] of plans.entries()) {
      for (const dependency of plan.dependencies || []) {
        const dependencyRecord = byKey.get(dependency) || records.find((item) => item.id === dependency);
        if (!dependencyRecord) throw new Error(`unknown work item dependency: ${dependency}`);
        this.store.addWorkItemDependency(records[index].id, dependencyRecord.id);
      }
    }
    return records;
  }

  #pendingConfirmation(taskGroupId) {
    const events = this.store.db.prepare(`
      SELECT * FROM demand_events
      WHERE task_group_id = ? AND result_json IS NOT NULL
      ORDER BY received_at DESC, id DESC
    `).all(taskGroupId);
    for (const event of events) {
      try {
        if (JSON.parse(event.result_json)?.status === "awaiting_confirmation") return event;
      } catch {}
    }
    return null;
  }

  async #supersedeAffectedWork(revisionId, explicitActions) {
    const items = this.store.db.prepare("SELECT * FROM work_items WHERE requirement_revision_id = ?").all(revisionId);
    const affected = [];
    for (const row of items) {
      if (row.status === "canceled" || row.status === "stale") continue;
      const action = explicitActions[row.id]
        || (ACTIVE_WORK_STATUSES.has(row.status) ? "rework" : ["closed", "passed"].includes(row.status) ? "revalidate" : "stale");
      if (ACTIVE_WORK_STATUSES.has(row.status)) await this.#stopWorkItem(row.id, "requirement_changed", false);
      const current = this.store.get("work_items", row.id);
      if (current.status !== action) this.store.updateWorkItemStatus(row.id, {
        expectedVersion: current.version,
        status: action,
        reason: "requirement_revision_superseded",
      });
      affected.push({ id: row.id, action });
    }
    return affected;
  }

  async schedule(taskGroupId) {
    const group = this.store.get("task_groups", taskGroupId);
    if (!group) throw new Error(`TaskGroup not found: ${taskGroupId}`);
    if (!ACTIVE_GROUP_STATUSES.has(group.status)) return [];
    let available = this.maxConcurrency - this.#activeWorkerCount();
    if (available <= 0) return [];
    const started = [];
    for (const item of this.store.listReadyWorkItems(taskGroupId)) {
      if (available <= 0) break;
      const claim = this.#claim(item);
      if (this.workspaceManager.checkConflicts?.(item.id, claim)?.length) continue;
      try {
        started.push(await this.#startWorkItem(group, item, claim));
        available -= 1;
      } catch (error) {
        if (!/conflict|locked|lease/i.test(error.message)) throw error;
      }
    }
    return started;
  }

  async tick(taskGroupId) {
    return this.schedule(taskGroupId);
  }

  async #startWorkItem(group, item, claim) {
    this.workspaceManager.hold(item.id, claim);
    const branch = `9codex/${safeSegment(group.id)}/${safeSegment(item.id)}`;
    let session;
    let lease;
    const locks = [];
    let worker;
    let run;
    try {
      const worktree = this.workspaceManager.createWorktree({
        taskGroup: group.id,
        workItem: item.id,
        branch,
        startPoint: "HEAD",
      });
      session = this.store.createWorkerSession({
        taskGroupId: group.id,
        workItemId: item.id,
        role: "worker",
        status: "creating",
        workspace: group.workspace,
        branch,
        worktree: worktree.worktree,
      });
      lease = this.store.acquireWorkItemLease({
        workItemId: item.id,
        workerSessionId: session.id,
        ttlMs: this.leaseTtlMs,
        now: this.#nowIso(),
      });
      for (const resourceKey of claim.resourceLocks) locks.push(this.store.acquireResourceLock({
        resourceKey,
        taskGroupId: group.id,
        workItemId: item.id,
        workerSessionId: session.id,
        ttlMs: this.leaseTtlMs,
        now: this.#nowIso(),
      }));
      const handoff = this.#handoff(group, item, session, worktree.worktree);
      worker = await this.adapter.createWorker(JSON.stringify(handoff, null, 2), {
        ...this.workerOptions,
        cwd: worktree.worktree,
        onEvent: (event, activeWorker) => {
          try {
            this.heartbeat({
              workerSessionId: session.id,
              timestamp: this.#nowIso(),
              phase: event?.type || "running",
            });
            this.onWorkerEvent({
              taskGroupId: group.id,
              workItemId: item.id,
              workerSessionId: session.id,
              runId: run?.id || null,
              event,
            });
            if (
              event?.type === "turn.completed"
              && Number(event?.usage?.input_tokens) >= this.contextRotateAtTokens
            ) {
              activeWorker.contextLimitReached = true;
              this.adapter.interruptWorker(activeWorker);
            }
          } catch {}
        },
      });
      const codexThreadId = worker?.threadId || worker?.sessionId || worker?.id || null;
      if (codexThreadId) {
        session = this.store.attachWorkerConversation(session.id, codexThreadId);
      }
      run = this.store.createRun({
        workerSessionId: session.id,
        workItemId: item.id,
        requirementRevisionId: item.requirement_revision_id,
        role: "worker",
        status: "running",
      });
      this.#setWorkStatus(item.id, "assigned", "worker_created");
      this.#setWorkStatus(item.id, "running", "worker_started");
      this.#setSessionStatus(session.id, "running", "run_started");
      this.store.heartbeatWorkerSession(session.id, { timestamp: this.#nowIso() });
      this.runtime.set(session.id, { worker, runId: run.id, lease, locks, workItemId: item.id, claimOwner: item.id });
      return {
        taskGroupId: group.id,
        workItemId: item.id,
        workerSessionId: session.id,
        runId: run.id,
        workerId: worker?.id || null,
        handoff,
      };
    } catch (error) {
      if (worker) {
        try { this.adapter.interruptWorker(worker); } catch {}
      }
      if (lease) this.store.releaseWorkItemLease(item.id, lease.token);
      for (const lock of locks) this.store.releaseResourceLock(lock.resourceKey, lock.token);
      try { this.workspaceManager.release(item.id); } catch {}
      if (session) this.#setSessionStatus(session.id, "corrupted", error.message);
      this.#setWorkStatus(item.id, "ready", "assignment_failed");
      throw error;
    }
  }

  #handoff(group, item, session, worktree) {
    const revision = this.store.get("requirement_revisions", item.requirement_revision_id);
    const checkpoint = this.store.db.prepare(`
      SELECT payload FROM checkpoints WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(item.id);
    const meta = metadata(item);
    return {
      type: "handoff_packet",
      taskGroupId: group.id,
      workItemId: item.id,
      workerSessionId: session.id,
      requirementRevisionId: revision.id,
      requirementRevision: revision.revision,
      goal: revision.normalized_requirement,
      work: { title: item.title, description: meta.description },
      acceptanceCriteria: item.acceptance_criteria,
      writeSet: item.write_set,
      readSet: meta.readSet,
      resourceLocks: meta.resourceLocks,
      workspace: worktree,
      checkpoint: checkpoint ? JSON.parse(checkpoint.payload) : null,
      reporting: { heartbeat: true, structuredReport: true, selfAcceptanceForbidden: true },
      security: {
        writeOnlyInsideWorktree: true,
        neverReadOrPrintCredentials: true,
        noProductionOrIrreversibleActions: true,
        noRemotePushOrPublish: true,
      },
    };
  }

  heartbeat(input) {
    const sessionId = requireText(input?.workerSessionId, "workerSessionId");
    const session = this.store.get("worker_sessions", sessionId);
    if (!session) throw new Error(`WorkerSession not found: ${sessionId}`);
    const runtime = this.runtime.get(sessionId);
    const updated = this.store.heartbeatWorkerSession(sessionId, {
      expectedVersion: session.version,
      timestamp: input.timestamp || this.#nowIso(),
    });
    if (runtime?.lease) runtime.lease = this.store.renewWorkItemLease({
      workItemId: session.work_item_id,
      token: runtime.lease.token,
      ttlMs: this.leaseTtlMs,
      now: input.timestamp || this.#nowIso(),
    });
    if (runtime?.locks?.length) runtime.locks = runtime.locks.map((lock) => this.store.acquireResourceLock({
      resourceKey: lock.resourceKey,
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      workerSessionId: session.id,
      token: lock.token,
      ttlMs: this.leaseTtlMs,
      now: input.timestamp || this.#nowIso(),
    }));
    let checkpoint = null;
    if (input.checkpoint || input.progressSummary || input.nextStep) checkpoint = this.saveCheckpoint({
      ...input,
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      workerSessionId: sessionId,
      runId: input.runId || runtime?.runId,
    });
    return { session: updated, checkpoint };
  }

  saveCheckpoint(input) {
    const payload = input.checkpoint || {
      taskGroupId: input.taskGroupId,
      workItemId: input.workItemId,
      requirementRevision: input.requirementRevision,
      phase: input.phase,
      progressSummary: input.progressSummary,
      changedFiles: input.changedFiles || [],
      currentCommand: input.currentCommand || null,
      nextStep: input.nextStep || null,
      blockedReason: input.blockedReason || null,
    };
    return this.store.saveCheckpoint({
      taskGroupId: requireText(input.taskGroupId, "taskGroupId"),
      workItemId: input.workItemId,
      workerSessionId: input.workerSessionId,
      runId: input.runId,
      payload,
    });
  }

  async reportWorker(input) {
    const session = this.store.get("worker_sessions", requireText(input?.workerSessionId, "workerSessionId"));
    if (!session || session.role !== "worker") throw new Error("worker session is required");
    const runtime = this.runtime.get(session.id);
    const runId = input.runId || runtime?.runId;
    const run = this.store.get("runs", runId);
    if (!run || run.worker_session_id !== session.id || run.role !== "worker") throw new Error("worker run is required");
    const revision = this.store.get("requirement_revisions", run.requirement_revision_id);
    if (run.status !== "running" || revision?.status !== "active") {
      throw new Error("stale or inactive worker run cannot report");
    }
    if (run.status === "running") this.store.updateRunStatus(run.id, { expectedVersion: run.version, status: "reported", reason: "worker_reported" });
    this.store.setRunReport(run.id, input.report || {});
    this.#setWorkStatus(session.work_item_id, "reported", "worker_reported");
    this.#setSessionStatus(session.id, "waiting", "awaiting_independent_review");
    if (input.checkpoint) this.saveCheckpoint({
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      workerSessionId: session.id,
      runId: run.id,
      checkpoint: input.checkpoint,
    });
    return this.verifyReported(session.work_item_id, { workerSessionId: session.id });
  }

  async failWorker(input) {
    const session = this.store.get("worker_sessions", requireText(input?.workerSessionId, "workerSessionId"));
    const run = this.store.get("runs", requireText(input?.runId, "runId"));
    if (!session || !run || run.worker_session_id !== session.id || run.status !== "running") {
      throw new Error("running worker session and run are required");
    }
    const serialized = JSON.stringify(input.failure || {});
    const evidence = this.store.addEvidence({
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      runId: run.id,
      type: "worker_process",
      source: "codex_adapter",
      exitCode: input.failure?.exitCode ?? null,
      contentHash: fingerprint(serialized),
      metadata: input.failure || {},
    });
    this.store.updateRunStatus(run.id, {
      expectedVersion: run.version,
      status: "failed",
      reason: "worker_process_failed",
    });
    this.#setSessionStatus(session.id, "interrupted", "worker_process_failed");
    this.#setWorkStatus(session.work_item_id, "failed", "worker_process_failed");
    await this.#releaseAssignment(session.work_item_id, session.id);
    this.#setWorkStatus(session.work_item_id, "rework", "worker_process_failed");
    this.#setWorkStatus(session.work_item_id, "ready", "worker_process_rework_ready");
    return { result: "failed", status: "ready", evidenceId: evidence.id };
  }

  async verifyReported(workItemId, options = {}) {
    const item = this.store.get("work_items", workItemId);
    if (!item) throw new Error(`WorkItem not found: ${workItemId}`);
    if (!['reported', 'verifying'].includes(item.status)) throw new Error(`WorkItem ${workItemId} is not reported`);
    this.#setWorkStatus(item.id, "verifying", "independent_review_started");
    const workerSession = options.workerSessionId
      ? this.store.get("worker_sessions", options.workerSessionId)
      : this.store.db.prepare(`SELECT * FROM worker_sessions WHERE work_item_id = ? AND role = 'worker' ORDER BY created_at DESC LIMIT 1`).get(item.id);
    const reviewer = this.store.createWorkerSession({
      taskGroupId: item.task_group_id,
      workItemId: item.id,
      role: "reviewer",
      status: "running",
      workspace: workerSession?.workspace || this.store.get("task_groups", item.task_group_id).workspace,
      branch: workerSession?.branch || null,
      worktree: workerSession?.worktree || null,
    });
    this.store.heartbeatWorkerSession(reviewer.id, { timestamp: this.#nowIso() });
    let reviewerRun = this.store.createRun({
      workerSessionId: reviewer.id,
      workItemId: item.id,
      requirementRevisionId: item.requirement_revision_id,
      role: "reviewer",
      status: "running",
    });
    let verification;
    try {
      const ignoredFiles = criteriaForVerification(item.acceptance_criteria)
        .some((criterion) => ["npm", "pnpm", "yarn"].includes(path.basename(criterion.command[0])))
        ? ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]
        : [];
      this.workspaceManager.assertWriteScope({
        worktree: workerSession?.worktree,
        writeSet: item.write_set,
        ignoredFiles,
      });
      verification = await this.verificationRunner(criteriaForVerification(item.acceptance_criteria), {
        cwd: workerSession?.worktree || reviewer.workspace,
        env: this.verificationEnv,
        artifactDir: path.join(this.artifactRoot, safeSegment(item.task_group_id), safeSegment(item.id), safeSegment(reviewerRun.id)),
        secrets: this.verificationSecrets,
      });
    } catch (error) {
      verification = {
        result: "failed",
        evidence: [{
          type: "scope_check",
          source: "task_orchestrator",
          result: "failed",
          exit_code: null,
          content_hash: fingerprint(error.message),
          metadata: { error: error.message },
        }],
      };
    }
    if (!verification?.evidence?.length) verification = {
      result: "failed",
      evidence: [{ type: "verification", source: "task_orchestrator", result: "failed", content_hash: fingerprint("missing evidence") }],
    };
    const evidence = verification.evidence.map((row) => this.store.addEvidence({
      taskGroupId: item.task_group_id,
      workItemId: item.id,
      runId: reviewerRun.id,
      type: row.type || "command",
      source: row.source || "verification_runner",
      command: Array.isArray(row.command) ? JSON.stringify(row.command) : row.command,
      exitCode: row.exit_code ?? row.exitCode ?? null,
      outputPath: row.output_path || row.outputPath || null,
      artifactPath: row.artifact_path || row.artifactPath || null,
      contentHash: row.content_hash || row.contentHash || fingerprint(row),
      metadata: { ...row, result: row.result },
    }));
    const passed = verification.result === "passed" && verification.evidence.every((row) => row.result === "passed");
    reviewerRun = this.store.updateRunStatus(reviewerRun.id, {
      expectedVersion: reviewerRun.version,
      status: passed ? "passed" : "failed",
      reason: passed ? "criteria_passed" : "criteria_failed",
    });
    this.#setSessionStatus(reviewer.id, "closed", "review_complete");
    if (passed) return this.#acceptWorkItem(item.id, reviewerRun, evidence, workerSession);
    return this.#rejectWorkItem(item.id, reviewerRun, evidence, verification, workerSession);
  }

  async #acceptWorkItem(workItemId, reviewerRun, evidence, workerSession) {
    const item = this.store.get("work_items", workItemId);
    let commitEvidence = null;
    let commit = null;
    if (workerSession?.worktree && typeof this.workspaceManager.commitWorktree === "function") {
      commit = await this.workspaceManager.commitWorktree({
        taskGroup: item.task_group_id,
        workItem: item.id,
        worktree: workerSession.worktree,
        writeSet: item.write_set,
        ignoredFiles: criteriaForVerification(item.acceptance_criteria)
          .some((criterion) => ["npm", "pnpm", "yarn"].includes(path.basename(criterion.command[0])))
          ? ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]
          : [],
        message: `9codex: ${item.title}`,
      });
      commitEvidence = this.store.addEvidence({
        taskGroupId: item.task_group_id,
        workItemId: item.id,
        runId: reviewerRun.id,
        type: "commit",
        source: "workspace_manager",
        contentHash: commit.head,
        metadata: commit,
      });
      evidence.push(commitEvidence);
    }
    this.store.addAcceptance({
      taskGroupId: item.task_group_id,
      scope: "work_item",
      scopeId: item.id,
      criteria: item.acceptance_criteria,
      result: "passed",
      evidenceIds: evidence.map((row) => row.id),
      verifiedByRunId: reviewerRun.id,
    });
    this.#setWorkStatus(item.id, "passed", "independent_review_passed");
    if (workerSession) await this.#closeWorkerSession(workerSession.id, "accepted");
    await this.#releaseAssignment(item.id, workerSession?.id);
    let integration = null;
    try {
      if (commit?.committed !== false) {
        integration = await this.#integrateWorkItem(item, workerSession);
      }
    } catch (error) {
      const blocked = /Target worktree is dirty/i.test(error.message);
      this.#setWorkStatus(item.id, blocked ? "blocked" : "rework", "integration_failed");
      if (!blocked) this.#setWorkStatus(item.id, "ready", "integration_failed");
      this.#setGroupStatus(item.task_group_id, blocked ? "blocked" : "executing", "integration_failed");
      return {
        result: "failed",
        phase: "integration",
        status: blocked ? "blocked" : "ready",
        workItemId: item.id,
        reviewerRunId: reviewerRun.id,
        error: error.message,
      };
    }
    this.#setWorkStatus(item.id, "closed", "accepted_and_integrated");
    await this.#maybeAcceptRequirement(item.requirement_revision_id, reviewerRun.id);
    const finalReport = await this.#maybeFinalize(item.task_group_id);
    return {
      result: "passed",
      workItemId: item.id,
      reviewerRunId: reviewerRun.id,
      evidenceIds: evidence.map((row) => row.id),
      integration,
      finalReport,
    };
  }

  async #integrateWorkItem(item, workerSession) {
    if (!workerSession?.branch || typeof this.workspaceManager.mergeAccepted !== "function") return null;
    this.#setGroupStatus(item.task_group_id, "integrating", "work_item_accepted");
    const integrator = this.store.createWorkerSession({
      taskGroupId: item.task_group_id,
      workItemId: item.id,
      role: "integrator",
      status: "running",
      workspace: workerSession.workspace,
      branch: workerSession.branch,
      worktree: workerSession.worktree,
    });
    this.store.heartbeatWorkerSession(integrator.id, { timestamp: this.#nowIso() });
    let integratorRun = this.store.createRun({
      workerSessionId: integrator.id,
      workItemId: item.id,
      requirementRevisionId: item.requirement_revision_id,
      role: "integrator",
      status: "running",
    });
    try {
      const result = await this.workspaceManager.mergeAccepted({
        taskGroup: item.task_group_id,
        items: [{ id: item.id, branch: workerSession.branch, accepted: true }],
        runTests: async ({ worktree }) => {
          const verification = await this.verificationRunner(criteriaForVerification(item.acceptance_criteria), {
            cwd: worktree,
            env: this.verificationEnv,
            artifactDir: path.join(this.artifactRoot, safeSegment(item.task_group_id), safeSegment(item.id), safeSegment(integratorRun.id)),
            secrets: this.verificationSecrets,
          });
          for (const row of verification.evidence || []) this.store.addEvidence({
            taskGroupId: item.task_group_id,
            workItemId: item.id,
            runId: integratorRun.id,
            type: row.type || "command",
            source: "integration_verification",
            command: Array.isArray(row.command) ? JSON.stringify(row.command) : row.command,
            exitCode: row.exit_code ?? null,
            outputPath: row.output_path || null,
            contentHash: row.content_hash || fingerprint(row),
            metadata: row,
          });
          return verification.result === "passed";
        },
      });
      integratorRun = this.store.updateRunStatus(integratorRun.id, {
        expectedVersion: integratorRun.version,
        status: "passed",
        reason: "integration_passed",
      });
      this.#setSessionStatus(integrator.id, "closed", "integration_passed");
      if (typeof this.workspaceManager.deleteWorktree === "function") {
        await this.workspaceManager.deleteWorktree({
          taskGroup: item.task_group_id,
          workItem: item.id,
          worktree: workerSession.worktree,
          force: true,
        });
      }
      this.#setGroupStatus(item.task_group_id, "executing", "integration_complete");
      return result;
    } catch (error) {
      this.store.updateRunStatus(integratorRun.id, {
        expectedVersion: integratorRun.version,
        status: "failed",
        reason: error.message,
      });
      this.#setSessionStatus(integrator.id, "closed", "integration_failed");
      throw error;
    }
  }

  async #rejectWorkItem(workItemId, reviewerRun, evidence, verification, workerSession) {
    const item = this.store.get("work_items", workItemId);
    const failedRows = verification.evidence.filter((row) => row.result !== "passed");
    const failureFingerprint = fingerprint(failedRows.map((row) => ({
      criterion: row.criterion_id || row.id || row.type,
      exitCode: row.exit_code ?? row.exitCode,
      contentHash: row.content_hash || row.contentHash,
      timedOut: row.timed_out || row.timedOut,
    })));
    const failureReason = JSON.stringify({ failureFingerprint, failedCriteria: failedRows.map((row) => row.criterion_id || row.id || row.type) });
    this.store.addAcceptance({
      taskGroupId: item.task_group_id,
      scope: "work_item",
      scopeId: item.id,
      criteria: item.acceptance_criteria,
      result: "failed",
      evidenceIds: evidence.map((row) => row.id),
      failureReason,
      verifiedByRunId: reviewerRun.id,
    });
    this.#setWorkStatus(item.id, "failed", "independent_review_failed");
    const repeated = this.store.db.prepare(`
      SELECT COUNT(*) AS count FROM acceptances
      WHERE scope = 'work_item' AND scope_id = ? AND result = 'failed' AND failure_reason LIKE ?
    `).get(item.id, `%${failureFingerprint}%`).count;
    if (workerSession) await this.#closeWorkerSession(workerSession.id, "verification_failed");
    await this.#releaseAssignment(item.id, workerSession?.id);
    if (Number(repeated) >= this.failureThreshold) {
      this.#setWorkStatus(item.id, "blocked", "repeated_failure_fingerprint");
      this.#setGroupStatus(item.task_group_id, "blocked", "repeated_failure_fingerprint");
      return { result: "blocked", workItemId: item.id, reviewerRunId: reviewerRun.id, failureFingerprint, attempts: Number(repeated) };
    }
    this.#setWorkStatus(item.id, "rework", "verification_failed");
    this.#setWorkStatus(item.id, "ready", "rework_ready");
    return { result: "failed", workItemId: item.id, reviewerRunId: reviewerRun.id, failureFingerprint, attempts: Number(repeated), status: "ready" };
  }

  async pause(taskGroupId) {
    this.#setGroupStatus(taskGroupId, "paused", "user_pause");
    for (const item of this.#activeWorkItems(taskGroupId)) await this.#stopWorkItem(item.id, "task_group_paused", true);
    return { status: "paused" };
  }

  async resume(taskGroupId) {
    const group = this.store.get("task_groups", taskGroupId);
    if (!group) throw new Error(`TaskGroup not found: ${taskGroupId}`);
    if (group.status === "canceled") throw new Error("canceled task group cannot resume");
    for (const item of this.store.db.prepare(`
      SELECT wi.id
      FROM work_items wi
      JOIN requirement_revisions rr ON rr.id = wi.requirement_revision_id
      WHERE wi.task_group_id = ? AND wi.status = 'blocked' AND rr.status = 'active'
    `).all(taskGroupId)) {
      this.#setWorkStatus(item.id, "ready", "user_resume");
    }
    this.#setGroupStatus(taskGroupId, "executing", "user_resume");
    return { status: "executing", started: [] };
  }

  async cancel(taskGroupId) {
    for (const item of this.#activeWorkItems(taskGroupId)) {
      await this.#stopWorkItem(item.id, "task_group_canceled", false);
      this.#setWorkStatus(item.id, "canceled", "task_group_canceled");
    }
    this.#setGroupStatus(taskGroupId, "canceled", "user_cancel");
    return { status: "canceled" };
  }

  async deleteWorkItem(taskGroupId, workItemId) {
    const item = this.store.get("work_items", requireText(workItemId, "workItemId"));
    requireText(taskGroupId, "taskGroupId");
    if (!item) return false;
    if (item.task_group_id !== taskGroupId) throw new Error(`WorkItem not found in TaskGroup: ${workItemId}`);
    const sessions = this.store.db.prepare(
      "SELECT id FROM worker_sessions WHERE task_group_id = ? AND work_item_id = ?",
    ).all(taskGroupId, workItemId);
    await this.#stopWorkersForDeletion(sessions, [workItemId]);
    return this.store.deleteWorkItem(taskGroupId, workItemId);
  }

  async deleteTaskGroup(taskGroupId) {
    requireText(taskGroupId, "taskGroupId");
    if (!this.store.get("task_groups", taskGroupId)) return false;
    const sessions = this.store.db.prepare(
      "SELECT id FROM worker_sessions WHERE task_group_id = ?",
    ).all(taskGroupId);
    const workItemIds = this.store.db.prepare(
      "SELECT id FROM work_items WHERE task_group_id = ?",
    ).all(taskGroupId).map((row) => row.id);
    await this.#stopWorkersForDeletion(sessions, workItemIds);
    return this.store.deleteTaskGroup(taskGroupId);
  }

  async clearTaskGroups() {
    const sessions = this.store.db.prepare("SELECT id FROM worker_sessions").all();
    const workItemIds = this.store.db.prepare("SELECT id FROM work_items").all().map((row) => row.id);
    await this.#stopWorkersForDeletion(sessions, workItemIds);
    return this.store.clearTaskGroups();
  }

  async rotateWorker(workerSessionId, checkpoint) {
    const session = this.store.get("worker_sessions", workerSessionId);
    if (!session) throw new Error(`WorkerSession not found: ${workerSessionId}`);
    if (checkpoint) this.saveCheckpoint({
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      workerSessionId,
      runId: this.runtime.get(workerSessionId)?.runId,
      checkpoint,
    });
    await this.#stopWorkItem(session.work_item_id, "context_rotation", true);
    return this.schedule(session.task_group_id);
  }

  async recover(options = {}) {
    const staleBefore = options.staleBefore || (
      options.recoverAllRunning
        ? new Date(this.#now().getTime() + 1).toISOString()
        : new Date(this.#now().getTime() - this.heartbeatTimeoutMs).toISOString()
    );
    const staleSessions = this.store.db.prepare(`
      SELECT DISTINCT ws.id FROM worker_sessions ws
      JOIN runs r ON r.worker_session_id = ws.id
      WHERE r.status = 'running' AND (ws.last_heartbeat_at IS NULL OR ws.last_heartbeat_at < ?)
    `).all(staleBefore);
    for (const { id } of staleSessions) {
      const runtime = this.runtime.get(id);
      if (runtime?.worker) {
        try { this.adapter.interruptWorker(runtime.worker); } catch {}
      }
    }
    const recovered = this.store.recover({ staleBefore });
    for (const sessionId of [...this.runtime.keys()]) {
      const session = this.store.get("worker_sessions", sessionId);
      if (!session || session.status === "lost") this.runtime.delete(sessionId);
    }
    const acceptedButUnfinished = this.store.db.prepare(`
      SELECT wi.id,
        (SELECT id FROM runs
          WHERE work_item_id = wi.id AND role = 'reviewer' AND status = 'passed'
          ORDER BY created_at DESC, id DESC LIMIT 1) AS reviewer_run_id,
        (SELECT id FROM worker_sessions
          WHERE work_item_id = wi.id AND role = 'worker'
          ORDER BY created_at DESC, id DESC LIMIT 1) AS worker_session_id
      FROM work_items wi
      JOIN task_groups tg ON tg.id = wi.task_group_id
      WHERE wi.status = 'verifying'
        AND wi.requirement_revision_id = tg.current_requirement_revision_id
        AND reviewer_run_id IS NOT NULL
    `).all();
    const resumedAcceptances = [];
    for (const row of acceptedButUnfinished) {
      const reviewerRun = this.store.get("runs", row.reviewer_run_id);
      const workerSession = row.worker_session_id
        ? this.store.get("worker_sessions", row.worker_session_id)
        : null;
      const evidence = this.store.db.prepare(
        "SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at, id",
      ).all(row.reviewer_run_id);
      resumedAcceptances.push(await this.#acceptWorkItem(row.id, reviewerRun, evidence, workerSession));
    }
    const taskGroups = [...new Set(recovered.readyWorkItems.map((workItemId) => this.store.get("work_items", workItemId)?.task_group_id).filter(Boolean))];
    const started = [];
    for (const taskGroupId of taskGroups) started.push(...await this.schedule(taskGroupId));
    return { ...recovered, resumedAcceptances, started, recoveredWithinMs: 0 };
  }

  async #stopWorkItem(workItemId, reason, makeReady) {
    const sessions = this.store.db.prepare(`
      SELECT * FROM worker_sessions WHERE work_item_id = ? AND role = 'worker'
        AND status IN ('creating','running','waiting','closing')
    `).all(workItemId);
    for (const session of sessions) {
      const runtime = this.runtime.get(session.id);
      const previous = this.store.db.prepare(
        "SELECT payload FROM checkpoints WHERE worker_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(session.id);
      this.saveCheckpoint({
        taskGroupId: session.task_group_id,
        workItemId,
        workerSessionId: session.id,
        runId: runtime?.runId,
        checkpoint: {
          ...(previous ? JSON.parse(previous.payload) : {}),
          taskGroupId: session.task_group_id,
          workItemId,
          nextStep: makeReady ? "Resume from this checkpoint" : "Stopped",
          closingReason: reason,
        },
      });
      if (runtime?.worker) {
        try { this.adapter.interruptWorker(runtime.worker); } catch {}
      }
      const runs = this.store.db.prepare("SELECT * FROM runs WHERE worker_session_id = ? AND status = 'running'").all(session.id);
      for (const run of runs) this.store.updateRunStatus(run.id, { expectedVersion: run.version, status: "interrupted", reason });
      this.#setSessionStatus(session.id, "interrupted", reason);
      await this.#releaseAssignment(workItemId, session.id);
    }
    if (makeReady) this.#setWorkStatus(workItemId, "ready", reason);
  }

  async #stopWorkersForDeletion(sessions, workItemIds) {
    for (const { id } of sessions) {
      const runtime = this.runtime.get(id);
      if (runtime?.worker) {
        try { this.adapter.interruptWorker(runtime.worker); } catch {}
        if (typeof this.adapter.closeWorker === "function") await this.adapter.closeWorker(runtime.worker);
      }
    }
    for (const workItemId of new Set(workItemIds)) {
      try { this.workspaceManager.release(workItemId); } catch {}
    }
    for (const { id } of sessions) this.runtime.delete(id);
  }

  async #closeWorkerSession(sessionId, reason) {
    const session = this.store.get("worker_sessions", sessionId);
    if (!session || session.status === "closed") return;
    const previous = this.store.db.prepare(
      "SELECT payload FROM checkpoints WHERE worker_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(session.id);
    this.saveCheckpoint({
      taskGroupId: session.task_group_id,
      workItemId: session.work_item_id,
      workerSessionId: session.id,
      runId: this.runtime.get(sessionId)?.runId,
      checkpoint: {
        ...(previous ? JSON.parse(previous.payload) : {}),
        taskGroupId: session.task_group_id,
        workItemId: session.work_item_id,
        nextStep: reason,
        closingReason: reason,
      },
    });
    this.#setSessionStatus(sessionId, "closing", reason);
    const runtime = this.runtime.get(sessionId);
    if (runtime?.worker) {
      try { await this.adapter.closeWorker(runtime.worker); } catch {}
    }
    this.#setSessionStatus(sessionId, "closed", reason);
  }

  async #releaseAssignment(workItemId, sessionId) {
    const lease = this.store.db.prepare("SELECT * FROM work_item_leases WHERE work_item_id = ?").get(workItemId);
    if (lease && (!sessionId || lease.worker_session_id === sessionId)) this.store.releaseWorkItemLease(workItemId, lease.token);
    const locks = this.store.db.prepare("SELECT * FROM resource_locks WHERE work_item_id = ?").all(workItemId);
    for (const lock of locks) if (!sessionId || lock.worker_session_id === sessionId) this.store.releaseResourceLock(lock.resource_key, lock.token);
    try { this.workspaceManager.release(workItemId); } catch {}
    if (sessionId) this.runtime.delete(sessionId);
  }

  async #maybeAcceptRequirement(revisionId, reviewerRunId) {
    const revision = this.store.get("requirement_revisions", revisionId);
    if (!revision || revision.status !== "active") return false;
    const items = this.store.db.prepare("SELECT * FROM work_items WHERE requirement_revision_id = ?").all(revisionId);
    if (!items.length || items.some((item) => item.status !== "closed")) return false;
    const existing = this.store.db.prepare(`SELECT 1 FROM acceptances WHERE scope = 'requirement' AND scope_id = ? AND result = 'passed' LIMIT 1`).get(revisionId);
    if (existing) return true;
    const evidenceIds = this.store.db.prepare(`
      SELECT DISTINCT e.id FROM evidence e JOIN work_items wi ON wi.id = e.work_item_id
      WHERE wi.requirement_revision_id = ?
    `).all(revisionId).map((row) => row.id);
    this.store.addAcceptance({
      taskGroupId: items[0].task_group_id,
      scope: "requirement",
      scopeId: revisionId,
      criteria: revision.acceptance_criteria,
      result: "passed",
      evidenceIds,
      verifiedByRunId: reviewerRunId,
    });
    this.store.updateRequirementStatus(revision.requirement_id, "passed");
    return true;
  }

  async #maybeFinalize(taskGroupId) {
    const activeRevisions = this.store.db.prepare(`
      SELECT rr.* FROM requirement_revisions rr JOIN requirements r ON r.id = rr.requirement_id
      WHERE r.task_group_id = ? AND r.status <> 'canceled' AND rr.status = 'active'
    `).all(taskGroupId);
    if (!activeRevisions.length) return null;
    for (const revision of activeRevisions) {
      const accepted = this.store.db.prepare(`SELECT 1 FROM acceptances WHERE scope = 'requirement' AND scope_id = ? AND result = 'passed' LIMIT 1`).get(revision.id);
      if (!accepted) return null;
    }
    const currentIds = new Set(activeRevisions.map((revision) => revision.id));
    const currentWork = this.store.db.prepare("SELECT * FROM work_items WHERE task_group_id = ?").all(taskGroupId).filter((item) => currentIds.has(item.requirement_revision_id));
    if (currentWork.some((item) => item.status !== "closed" && item.status !== "canceled")) return null;
    for (const old of this.store.db.prepare("SELECT * FROM work_items WHERE task_group_id = ?").all(taskGroupId)) {
      if (!currentIds.has(old.requirement_revision_id) && !TERMINAL_WORK_STATUSES.has(old.status)) this.#setWorkStatus(old.id, "stale", "superseded_requirement_completed");
    }
    const existing = this.store.db.prepare(`SELECT 1 FROM acceptances WHERE scope = 'task_group' AND scope_id = ? AND result = 'passed' LIMIT 1`).get(taskGroupId);
    if (!existing) {
      const group = this.store.get("task_groups", taskGroupId);
      const criteria = criteriaForVerification(
        activeRevisions.flatMap((revision) => JSON.parse(revision.acceptance_criteria || "[]")),
      );
      const verifier = this.store.createWorkerSession({
        taskGroupId,
        role: "integrator",
        status: "running",
        workspace: group.workspace,
      });
      this.store.heartbeatWorkerSession(verifier.id, { timestamp: this.#nowIso() });
      let verifierRun = this.store.createRun({
        workerSessionId: verifier.id,
        role: "integrator",
        status: "running",
      });
      const verification = await this.verificationRunner(criteria, {
        cwd: group.workspace,
        env: this.verificationEnv,
        artifactDir: path.join(this.artifactRoot, safeSegment(taskGroupId), "final", safeSegment(verifierRun.id)),
        secrets: this.verificationSecrets,
      });
      const evidence = (verification.evidence || []).map((row) => this.store.addEvidence({
        taskGroupId,
        runId: verifierRun.id,
        type: row.type === "command" ? "business_path" : row.type || "business_path",
        source: "task_group_verification",
        command: Array.isArray(row.command) ? JSON.stringify(row.command) : row.command,
        exitCode: row.exit_code ?? null,
        outputPath: row.output_path || null,
        contentHash: row.content_hash || fingerprint(row),
        metadata: row,
      }));
      const passed = verification?.result === "passed"
        && verification?.evidence?.length
        && verification.evidence.every((row) => row.result === "passed");
      verifierRun = this.store.updateRunStatus(verifierRun.id, {
        expectedVersion: verifierRun.version,
        status: passed ? "passed" : "failed",
        reason: passed ? "task_group_verification_passed" : "task_group_verification_failed",
      });
      this.#setSessionStatus(verifier.id, "closed", "task_group_verification_complete");
      this.store.addAcceptance({
        taskGroupId,
        scope: "task_group",
        scopeId: taskGroupId,
        criteria,
        result: passed ? "passed" : "failed",
        evidenceIds: evidence.map((row) => row.id),
        failureReason: passed ? null : "final task-group verification failed",
        verifiedByRunId: verifierRun.id,
      });
      if (!passed) {
        this.#setGroupStatus(taskGroupId, "blocked", "task_group_verification_failed");
        return null;
      }
    }
    this.#setGroupStatus(taskGroupId, "done", "all_latest_requirements_passed");
    return this.finalReport(taskGroupId, true);
  }

  finalReport(taskGroupId, persist = false) {
    const group = this.store.get("task_groups", taskGroupId);
    if (!group) throw new Error(`TaskGroup not found: ${taskGroupId}`);
    const revisions = this.store.db.prepare(`
      SELECT rr.*, r.title requirement_title FROM requirement_revisions rr
      JOIN requirements r ON r.id = rr.requirement_id WHERE r.task_group_id = ? ORDER BY rr.created_at
    `).all(taskGroupId).map((row) => ({ ...row, acceptance_criteria: JSON.parse(row.acceptance_criteria || "[]") }));
    const workItems = this.store.db.prepare("SELECT * FROM work_items WHERE task_group_id = ? ORDER BY created_at").all(taskGroupId).map((row) => ({ ...row, write_set: JSON.parse(row.write_set || "[]") }));
    const sessions = this.store.db.prepare("SELECT * FROM worker_sessions WHERE task_group_id = ? ORDER BY created_at").all(taskGroupId);
    const evidence = this.store.db.prepare("SELECT * FROM evidence WHERE task_group_id = ? ORDER BY created_at").all(taskGroupId);
    const report = {
      taskGroup: { id: group.id, title: group.title, goal: revisions.filter((row) => row.status === "active").map((row) => row.normalized_requirement), status: group.status },
      finalRequirementVersions: revisions.filter((row) => row.status === "active").map((row) => ({ requirement: row.requirement_title, revision: row.revision, id: row.id })),
      completedRequirements: revisions.filter((row) => row.status === "active").map((row) => row.requirement_title),
      completedWorkItems: workItems.filter((row) => row.status === "closed").map((row) => ({ id: row.id, title: row.title })),
      codeChanges: [...new Set(workItems.flatMap((row) => row.write_set))],
      commits: evidence.filter((row) => row.type === "commit"),
      testResults: evidence.filter((row) => ["command", "test"].includes(row.type)),
      buildResults: evidence.filter((row) => row.type === "build"),
      businessPathVerification: evidence.filter((row) => row.type === "business_path"),
      unresolvedRisks: workItems.filter((row) => row.status === "blocked").map((row) => row.title),
      canceledOrSupersededWork: workItems.filter((row) => ["canceled", "stale", "revalidate", "rework"].includes(row.status)).map((row) => ({ id: row.id, status: row.status, title: row.title })),
      internalSessions: sessions.map((row) => ({ id: row.id, role: row.role, status: row.status, closedAt: row.closed_at })),
      finalDecision: group.status === "done" ? "passed" : "incomplete",
      generatedAt: this.#nowIso(),
    };
    if (persist) {
      const directory = path.join(this.artifactRoot, safeSegment(taskGroupId));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const reportPath = path.join(directory, `final-report-${Date.now()}.json`);
      const contents = `${JSON.stringify(report, null, 2)}\n`;
      fs.writeFileSync(reportPath, contents, { mode: 0o600 });
      this.store.addArtifact({
        taskGroupId,
        kind: "final_report",
        path: reportPath,
        contentHash: crypto.createHash("sha256").update(contents).digest("hex"),
        sizeBytes: Buffer.byteLength(contents),
      });
      report.path = reportPath;
    }
    return report;
  }

  #finishDemand(eventKey, result) {
    this.store.completeDemandEvent(eventKey, result);
  }

  #claim(item) {
    const meta = metadata(item);
    return { writeSet: item.write_set || [], readSet: meta.readSet || [], resourceLocks: meta.resourceLocks || [] };
  }

  #activeWorkerCount() {
    return Number(this.store.db.prepare(`
      SELECT COUNT(*) AS count FROM worker_sessions ws
      WHERE ws.role = 'worker' AND ws.status IN ('creating','running')
        AND EXISTS (
          SELECT 1 FROM runs r
          WHERE r.worker_session_id = ws.id AND r.status = 'running'
        )
    `).get().count);
  }

  #activeWorkItems(taskGroupId) {
    return this.store.db.prepare(`
      SELECT * FROM work_items WHERE task_group_id = ? AND status NOT IN ('closed','stale','canceled') ORDER BY created_at
    `).all(taskGroupId).map((row) => this.store.get("work_items", row.id));
  }

  #setGroupStatus(id, status, reason) {
    const current = this.store.get("task_groups", id);
    if (!current || current.status === status) return current;
    return this.store.updateTaskGroupStatus(id, { expectedVersion: current.version, status, reason });
  }

  #setWorkStatus(id, status, reason) {
    const current = this.store.get("work_items", id);
    if (!current || current.status === status || TERMINAL_WORK_STATUSES.has(current.status) && status !== "revalidate") return current;
    return this.store.updateWorkItemStatus(id, { expectedVersion: current.version, status, reason });
  }

  #setSessionStatus(id, status, reason) {
    const current = this.store.get("worker_sessions", id);
    if (!current || current.status === status || current.status === "closed") return current;
    return this.store.updateWorkerSessionStatus(id, { expectedVersion: current.version, status, reason });
  }

  #now() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  #nowIso() {
    return this.#now().toISOString();
  }
}

export function createTaskOrchestrator(options) {
  return new TaskOrchestrator(options);
}
