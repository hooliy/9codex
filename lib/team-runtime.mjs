import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { createCodexRuntime } from "./codex-runtime.mjs";
import { createHarnessRuntime } from "./harness-runtime.mjs";
import { classifyRuntimeFailure } from "./runtime-driver.mjs";
import { loadConfig } from "./config.mjs";
import { syncBootstrap } from "./control-plane.mjs";
import { reconcileModelState } from "./model-state.mjs";
import { createTaskOrchestrator } from "./task-orchestrator.mjs";
import { listCodexProcesses, restartCodex } from "./platform.mjs";
import { startTaskboard } from "./taskboard.mjs";
import {
  applyTaskCenterBridge,
  buildTaskCenterPayload,
  desktopDebugPort,
} from "./task-center-bridge.mjs";
import { openTeamStore } from "./team-store.mjs";
import { createTeamPlanner } from "./team-planner.mjs";
import { createWorkspaceManager } from "./workspace-manager.mjs";

const ACTIVE_GROUPS = new Set(["planning", "executing", "integrating", "verifying"]);

function configuredHarnessRuntime(paths, config) {
  return createHarnessRuntime({
    command: config.team.harness.command,
    args: config.team.harness.args,
    cordis_config: config.team.harness.cordis_config,
    provider: config.team.harness.provider,
    model: config.team.harness.model,
    max_tokens: config.team.harness.max_tokens,
    request_timeout_ms: config.team.harness.request_timeout_ms,
    stateDir: paths.stateDir,
    env: Object.fromEntries([
      ["NINECODEX_HARNESS_API_KEY", config.upstream.api_key],
      ["NINECODEX_HARNESS_BASE_URL", config.upstream.base_url],
      ["NINECODEX_HARNESS_MODEL", config.team.harness.model],
    ].filter(([, value]) => value)),
  });
}

export async function repairRuntimeConfiguration(paths, previousConfig, failure, options = {}) {
  const read = options.loadConfig || loadConfig;
  const active = read(paths);
  if (failure.category === "upstream_authentication_failed") {
    if (active.upstream.api_key !== previousConfig.upstream.api_key) return active;
    if (
      active.control_plane?.base_url
      && active.control_plane?.authorization_id
      && active.control_plane?.refresh_token
    ) {
      return (await (options.syncBootstrap || syncBootstrap)(paths, active, options)).config;
    }
    throw new Error("no refreshed upstream credentials are available");
  }
  if (failure.category === "model_unavailable") {
    return (await (options.reconcileModelState || reconcileModelState)(paths, active, options)).config;
  }
  return active;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function prepareWorkerHome(paths, config) {
  const workerHome = path.join(paths.stateDir, "team-codex-home");
  fs.mkdirSync(workerHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(workerHome, 0o700);
  const codexHome = paths.codexHome || workerHome;
  if (codexHome === workerHome) fs.writeFileSync(path.join(workerHome, "config.toml"), [
    `model = ${tomlString(config.upstream.default_model)}`,
    'model_provider = "9codex"',
    `model_catalog_json = ${tomlString(paths.catalog)}`,
    "",
    "[model_providers.9codex]",
    'name = "9codex"',
    `base_url = ${tomlString(`http://${config.local.host}:${config.local.port}/v1`)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    `experimental_bearer_token = ${tomlString(config.local.token)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  const allowed = ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot"];
  const inherited = Object.fromEntries(
    allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  );
  return {
    ...inherited,
    PATH: [path.dirname(process.execPath), inherited.PATH].filter(Boolean).join(path.delimiter),
    NODE: process.execPath,
    NODE_EXEC_PATH: process.execPath,
    HOME: workerHome,
    CODEX_HOME: codexHome,
  };
}

export function publishCodexThread(codexHome, input) {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(databasePath)) throw new Error(`Codex database not found: ${databasePath}`);
  const db = new DatabaseSync(databasePath);
  let result;
  try {
    result = db.prepare(`
      UPDATE threads
      SET title = ?, name = ?, updated_at = MAX(updated_at, unixepoch()),
          updated_at_ms = MAX(updated_at_ms, unixepoch() * 1000),
          recency_at = MAX(recency_at, unixepoch()),
          recency_at_ms = MAX(recency_at_ms, unixepoch() * 1000)
      WHERE id = ?
    `).run(input.title, input.title, input.threadId);
  } finally {
    db.close();
  }
  if (result.changes === 0) throw new Error(`Codex thread not found: ${input.threadId}`);
  return input;
}

export function preflightWorkerNode(env) {
  const result = spawnSync(process.execPath, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    signal: result.signal,
    error: result.error?.message || result.stderr?.trim() || null,
  };
}

class WorkspaceRouter {
  constructor(store) {
    this.store = store;
    this.managers = new Map();
  }

  #manager(owner) {
    const item = this.store.get("work_items", owner);
    if (!item) throw new Error(`WorkItem not found: ${owner}`);
    const group = this.store.get("task_groups", item.task_group_id);
    const workspace = fs.realpathSync(group.workspace);
    let manager = this.managers.get(workspace);
    if (!manager) {
      manager = createWorkspaceManager(workspace);
      this.managers.set(workspace, manager);
    }
    return manager;
  }

  checkConflicts(owner, claim) { return this.#manager(owner).checkConflicts(owner, claim); }
  hold(owner, claim) { return this.#manager(owner).hold(owner, claim); }
  release(owner) {
    try { return this.#manager(owner).release(owner); } catch { return false; }
  }
  createWorktree(options) { return this.#manager(options.workItem).createWorktree(options); }
  restoreWorktree(options) { return this.#manager(options.workItem).restoreWorktree(options); }
  assertWriteScope(options) {
    const session = this.store.db.prepare(
      "SELECT work_item_id FROM worker_sessions WHERE worktree = ? ORDER BY created_at DESC LIMIT 1",
    ).get(options.worktree);
    if (!session) throw new Error(`Worktree is not owned by a WorkerSession: ${options.worktree}`);
    return this.#manager(session.work_item_id).assertWriteScope(options);
  }
  commitWorktree(options) { return this.#manager(options.workItem).commitWorktree(options); }
  deleteWorktree(options) { return this.#manager(options.workItem).deleteWorktree(options); }
  mergeAccepted(options) {
    const item = options.items?.[0];
    if (!item) throw new Error("merge item is required");
    return this.#manager(item.id).mergeAccepted(options);
  }
}

function finalMessage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index]?.data || {};
    const notificationEvent = data.notification?.params?.event || {};
    const text = data.text
      || data.item?.text
      || data.item?.content?.map?.((part) => part?.text).filter(Boolean).join("\n")
      || data.item?.output
      || data.message?.content
      || data.last_message
      || notificationEvent.data?.chunk?.text
      || notificationEvent.data?.message?.content
        ?.filter?.((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function redactEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => ![
    "authorization", "api_key", "body", "input", "messages",
  ].includes(key)));
}

function shortText(value, limit = 12_000) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\n…已截断` : text;
}

function workerActivity(event) {
  const data = event?.data || {};
  const item = data.item || {};
  const message = data.message || {};
  const notificationEvent = data.notification?.params?.event || {};
  return {
    type: event?.type || "worker.event",
    item_type: item.type || null,
    text: shortText(
      data.text
      || item.text
      || item.content?.map?.((part) => part?.text).filter(Boolean).join("\n")
      || message.content
      || data.last_message
      || notificationEvent.data?.chunk?.text,
    ),
    command: shortText(item.command || data.command),
    output: shortText(
      item.aggregated_output
      || item.output
      || data.output
      || data.result,
    ),
    files: item.files || item.changes || data.files || null,
  };
}

export class TeamRuntime {
  constructor(options) {
    Object.assign(this, options);
    this.supervisions = new Map();
    this.closed = false;
    this.desktopBridgeFailures = 0;
    this.desktopRepairProcessKey = null;
    this.desktopRepairAt = 0;
    this.desktopRepairing = null;
    this.taskCenterActionResults = new Map();
    this.taskCenterSyncing = null;
    this.ticking = null;
    this.outboxPublishing = null;
  }

  async start() {
    if (!this.#workerNodeReady()) return this;
    const recovered = await this.orchestrator.recover({ recoverAllRunning: true });
    for (const assignment of recovered.started || []) this.#supervise(assignment);
    this.taskboard = await startTaskboard({
      host: this.config.team.host,
      port: this.config.team.port,
      token: this.config.team.token,
      maxWorkers: this.config.team.max_workers,
      store: this.store,
      orchestrator: this.orchestrator,
      onError: this.onError,
    });
    this.scheduler = setInterval(() => void this.tick().catch(this.onError), 1000);
    this.scheduler.unref();
    this.taskCenterBridge = setInterval(() => void this.syncTaskCenterBridge(), 2000);
    this.taskCenterBridge.unref();
    this.backups = setInterval(
      () => void this.backup().catch(this.onError),
      Math.max(60, Number(this.config.team.backup_interval_seconds) || 3600) * 1000,
    );
    this.backups.unref();
    await this.tick();
    await this.syncTaskCenterBridge();
    return this;
  }

  async syncTaskCenterBridge() {
    if (this.taskCenterSyncing) return this.taskCenterSyncing;
    this.taskCenterSyncing = this.#syncTaskCenterBridge();
    try {
      return await this.taskCenterSyncing;
    } finally {
      this.taskCenterSyncing = null;
    }
  }

  async #syncTaskCenterBridge() {
    const port = desktopDebugPort(this.paths.desktopSession);
    if (!port) {
      this.desktopBridgeFailures += 1;
      await this.#repairDesktopIntegration();
      return null;
    }
    try {
      const result = await (this.taskCenterBridgeApply || applyTaskCenterBridge)({
        port,
        taskGroups: buildTaskCenterPayload(this.store, {
          maxWorkers: this.config.team.max_workers,
        }),
        taskboardUrl: `http://${this.config.team.host}:${this.config.team.port}/#token=${encodeURIComponent(this.config.team.token)}`,
        actionResults: [...this.taskCenterActionResults.values()],
      });
      this.taskCenterActionResults.clear();
      for (const action of result.actions || []) {
        if (!action.actionId || this.taskCenterActionResults.has(action.actionId)) continue;
        try {
          if (action.type === "confirm") {
            const group = this.store.get("task_groups", action.taskGroupId);
            if (!group) throw new Error("任务组不存在");
            await this.orchestrator.confirmDemand({
              eventKey: action.eventKey,
              approved: true,
              approvalSourceMessageId: `task-center:${action.actionId}`,
            });
          } else if (action.type === "delete_work_item") {
            await this.orchestrator.deleteWorkItem(action.taskGroupId, action.workItemId);
          } else if (action.type === "stop_work_item") {
            await this.orchestrator.stopWorkItem(action.taskGroupId, action.workItemId);
          } else if (action.type === "retry_work_item") {
            await this.orchestrator.retryWorkItem(action.taskGroupId, action.workItemId);
          } else if (action.type === "clear_all") {
            await this.orchestrator.clearTaskGroups();
          }
          this.taskCenterActionResults.set(action.actionId, { actionId: action.actionId, ok: true });
        } catch (error) {
          this.taskCenterActionResults.set(action.actionId, {
            actionId: action.actionId,
            ok: false,
            error: error?.message || String(error),
          });
        }
      }
      this.desktopBridgeFailures = 0;
      this.taskCenterBridgeStatus = result;
      return result;
    } catch (error) {
      this.desktopBridgeFailures += 1;
      await this.#repairDesktopIntegration();
      this.taskCenterBridgeStatus = {
        connected: false,
        verified: false,
        error: error.message,
      };
      return this.taskCenterBridgeStatus;
    }
  }

  async #repairDesktopIntegration() {
    if (this.desktopBridgeFailures < 3 || this.desktopRepairing) return null;
    const processes = await (this.listCodexProcesses || listCodexProcesses)();
    if (processes.length === 0) return null;
    try {
      const session = JSON.parse(fs.readFileSync(this.paths.desktopSession, "utf8"));
      if (session.process_ids?.some((pid) => processes.some((item) => item.pid === pid))) {
        return null;
      }
    } catch {}
    const processKey = processes.map(({ pid }) => pid).sort((a, b) => a - b).join(",");
    if (
      processKey === this.desktopRepairProcessKey
      || Date.now() - this.desktopRepairAt < 60_000
    ) return null;
    this.desktopRepairProcessKey = processKey;
    this.desktopRepairAt = Date.now();
    this.desktopRepairing = (this.restartCodex || restartCodex)({
      sessionFile: this.paths.desktopSession,
    });
    try {
      return await this.desktopRepairing;
    } catch (error) {
      this.onError?.(error);
      return null;
    } finally {
      this.desktopRepairing = null;
    }
  }

  async tick() {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking = this.#tick();
    try {
      return await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  async #tick() {
    if (!this.#workerNodeReady()) return;
    const recovered = await this.orchestrator.recover();
    for (const assignment of recovered.started || []) this.#supervise(assignment);
    for (const group of this.store.listTaskGroups()) {
      if (!ACTIVE_GROUPS.has(group.status)) continue;
      for (const assignment of await this.orchestrator.schedule(group.id)) {
        this.#supervise(assignment);
      }
    }
    await this.publishOutbox();
  }

  #workerNodeReady() {
    if (this.workerPreflightResult) return this.workerPreflightResult.ok;
    const result = (this.workerPreflight || preflightWorkerNode)(this.workerEnv || process.env);
    this.workerPreflightResult = result;
    if (result.ok) return true;
    const reason = `Worker Node.js preflight failed: ${result.error || `exit ${result.code ?? "unknown"}${result.signal ? ` signal ${result.signal}` : ""}`}`;
    try {
      this.store.db.prepare("ALTER TABLE work_items ADD COLUMN waiting_reason TEXT").run();
    } catch {}
    this.store.db.prepare(`
      UPDATE work_items
      SET status = 'blocked', waiting_reason = ?, updated_at = ?
      WHERE status NOT IN ('done', 'blocked', 'canceled')
    `).run(reason, new Date().toISOString());
    this.onError?.(new Error(reason));
    return false;
  }

  #supervise(assignment) {
    if (!assignment.workerId || this.supervisions.has(assignment.workerSessionId)) return;
    const selectedRuntime = this.#runtimeFor(assignment.runtimeKind);
    const promise = (async () => {
      let activeRunId = assignment.runId || null;
      let recoveryStarted = false;
      const modelCallStartTimeoutMs = Math.max(
        1_000,
        Number(this.config.team.model_call_start_timeout_seconds || 300) * 1000,
      );
      const modelCallStallMs = Math.max(
        1_000,
        Number(this.config.team.model_call_stall_seconds || 900) * 1000,
      );
      const watchdog = setInterval(() => {
        try {
          this.orchestrator.heartbeat({
            workerSessionId: assignment.workerSessionId,
            timestamp: new Date().toISOString(),
            phase: "running",
          });
        } catch (error) {
          this.onError?.(error);
        }
        const inspection = selectedRuntime.inspectWorker?.(assignment.workerId);
        const stalled = inspection?.phase === "model_waiting"
          && inspection.lastRuntimeEventAt
          && Date.now() - inspection.lastRuntimeEventAt > modelCallStallMs;
        const neverStarted = inspection?.phase === "starting"
          && inspection.lastRuntimeEventAt
          && Date.now() - inspection.lastRuntimeEventAt > modelCallStartTimeoutMs;
        if (!recoveryStarted && (inspection?.failure || stalled || neverStarted)) {
          recoveryStarted = true;
          void this.#recoverWorker(assignment, {
              ...(inspection.failure || {
                category: neverStarted ? "upstream_first_event_timeout" : "upstream_stream_stalled",
                recoverable: true,
                code: neverStarted ? "MODEL_CALL_START_TIMEOUT" : "MODEL_CALL_STALLED",
              }),
              phase: inspection.phase,
              lastRuntimeEventAt: new Date(inspection.lastRuntimeEventAt).toISOString(),
          }).then((recovered) => {
            selectedRuntime.interruptWorker?.(assignment.workerId);
            for (const replacement of recovered.started || []) this.#supervise(replacement);
          }).catch(this.onError);
        }
      }, Math.max(1000, Math.floor((Number(this.orchestrator.heartbeatTimeoutMs) || 60_000) / 4)));
      watchdog.unref();
      try {
        const result = await selectedRuntime.waitWorker(assignment.workerId);
        if (recoveryStarted) return;
        if (this.store.get("runs", assignment.runId)?.status !== "running") return;
        const events = selectedRuntime.readEvents(assignment.workerId);
        const worker = selectedRuntime.workers?.get?.(assignment.workerId);
        const inspection = selectedRuntime.inspectWorker?.(assignment.workerId);
        if (inspection?.failure) {
          const recovered = await this.#recoverWorker(assignment, inspection.failure);
          for (const replacement of recovered?.started || []) this.#supervise(replacement);
          return;
        }
        if (worker?.contextLimitReached) {
          const replacements = await this.orchestrator.rotateWorker(assignment.workerSessionId, {
            taskGroupId: assignment.taskGroupId,
            workItemId: assignment.workItemId,
            completedWork: [],
            changedFiles: [],
            commits: [],
            testResults: [],
            remainingWork: ["Continue from rotated context"],
            knownRisks: [],
            nextStep: "Resume with a fresh Codex context",
          });
          for (const replacement of replacements) this.#supervise(replacement);
          return;
        }
        if (!result.ok) {
          const messages = events
            .map((event) => event.data?.text || event.data?.message || event.data?.item?.text)
            .filter(Boolean);
          const failure = classifyRuntimeFailure({
            code: result.code,
            message: messages.join("\n"),
          });
          const handler = failure.category === "worker_process_failed"
            ? "failWorker"
            : "recoverWorker";
          const recovered = handler === "recoverWorker"
            ? await this.#recoverWorker(assignment, {
                ...failure,
                type: "model_call",
                exitCode: result.code,
                signal: result.signal,
                events: messages,
              })
            : await this.orchestrator.failWorker({
              workerSessionId: assignment.workerSessionId,
              runId: assignment.runId,
              failure: {
                ...failure,
                type: "worker_process",
                exitCode: result.code,
                signal: result.signal,
                events: messages,
              },
            });
          for (const replacement of recovered?.started || []) this.#supervise(replacement);
          return;
        }
        await this.orchestrator.reportWorker({
          workerSessionId: assignment.workerSessionId,
          runId: assignment.runId,
          report: {
            process: result,
            summary: finalMessage(events),
            eventCount: events.length,
          },
          checkpoint: {
            taskGroupId: assignment.taskGroupId,
            workItemId: assignment.workItemId,
            completedWork: [],
            changedFiles: [],
            commits: [],
            testResults: [],
            remainingWork: [],
            knownRisks: result.ok ? [] : [`${assignment.runtimeKind} exited with ${result.code}`],
            nextStep: "Independent verification",
          },
        });
      } catch (error) {
        this.onError(error);
        if (recoveryStarted) return;
        if (this.store.get("runs", assignment.runId)?.status !== "running") return;
        try {
          const failure = classifyRuntimeFailure(error);
          const handler = failure.category === "worker_process_failed"
            ? "failWorker"
            : "recoverWorker";
          const recovered = handler === "recoverWorker"
            ? await this.#recoverWorker(assignment, { ...failure, message: error.message })
            : await this.orchestrator.failWorker({
                workerSessionId: assignment.workerSessionId,
                runId: assignment.runId,
                failure: { ...failure, message: error.message },
              });
          for (const replacement of recovered?.started || []) this.#supervise(replacement);
        } catch (reportError) {
          this.onError(reportError);
        }
      } finally {
        clearInterval(watchdog);
        this.supervisions.delete(assignment.workerSessionId);
      }
    })();
    this.supervisions.set(assignment.workerSessionId, promise);
  }

  async #recoverWorker(assignment, failure) {
    let repaired = failure;
    if (["upstream_authentication_failed", "model_unavailable"].includes(failure.category)) {
      try {
        const config = await (this.repairRuntimeConfig || repairRuntimeConfiguration)(
          this.paths,
          this.config,
          failure,
        );
        this.config = config;
        if (assignment.runtimeKind === "deepseek-harness") {
          this.harnessRuntime = configuredHarnessRuntime(this.paths, config);
        }
        repaired = {
          ...failure,
          recoveryAction: failure.category === "upstream_authentication_failed"
            ? "refresh_credentials"
            : "refresh_model_catalog",
        };
      } catch (error) {
        repaired = {
          ...failure,
          recoverable: false,
          repairError: error.message,
          recoveryAction: "runtime_configuration_repair_failed",
        };
      }
    }
    return this.orchestrator.recoverWorker({
      workerSessionId: assignment.workerSessionId,
      runId: assignment.runId,
      failure: repaired,
    });
  }

  #runtimeFor(runtimeKind) {
    if (runtimeKind === "codex") return this.codexRuntime;
    if (runtimeKind === "deepseek-harness") return this.harnessRuntime;
    throw new Error(`Unsupported runtime_kind: ${runtimeKind}`);
  }

  observeTeamEvent(event) {
    if (!event || event.subagent || !event.threadId) return null;
    let group = this.store.getTaskGroupByThread(event.threadId);
    if (!group && event.type === "thread_observed") {
      group = this.store.createTaskGroup({
        originThreadId: event.threadId,
        title: `Codex task ${event.threadId.slice(0, 8)}`,
        workspace: this.defaultWorkspace,
      });
    }
    if (!group) return null;
    this.store.recordExternalEvent({
      taskGroupId: group.id,
      aggregateType: "gateway",
      aggregateId: event.requestId || event.threadId,
      eventType: `gateway.${event.type}`,
      payload: redactEvent(event),
    });
    return group;
  }

  async backup() {
    fs.mkdirSync(this.paths.backupsDir, { recursive: true, mode: 0o700 });
    const destination = path.join(this.paths.backupsDir, `team-${Date.now()}.sqlite`);
    const result = await this.store.createBackup(destination);
    const restorePath = path.join(this.paths.backupsDir, `.restore-drill-${Date.now()}.sqlite`);
    fs.copyFileSync(destination, restorePath);
    try {
      const restored = await openTeamStore(restorePath);
      restored.listTaskGroups();
      restored.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${restorePath}${suffix}`, { force: true });
    }
    return { ...result, restoreDrill: "passed" };
  }

  async publishOutbox() {
    if (this.outboxPublishing) return this.outboxPublishing;
    this.outboxPublishing = this.#publishOutbox();
    try {
      return await this.outboxPublishing;
    } finally {
      this.outboxPublishing = null;
    }
  }

  async #publishOutbox() {
    const published = [];
    for (const row of this.store.pendingOutbox(100)) {
      try {
        const payload = row.payload || {};
        const group = payload.taskGroupId
          ? this.store.get("task_groups", payload.taskGroupId)
          : null;
        if (
          row.topic === "task_group.status_changed"
          && ["blocked", "done"].includes(payload.to)
          && group?.runtime_kind === "codex"
        ) {
          if (typeof this.codexRuntime.resumeThread === "function") {
            let message;
            if (payload.to === "done") {
              const report = this.store.db.prepare(`
                SELECT * FROM artifacts WHERE task_group_id = ? AND kind = 'final_report'
                ORDER BY created_at DESC LIMIT 1
              `).get(group.id);
              if (!report || !fs.existsSync(report.path)) continue;
              message = `9codex 持久任务组已完成。原样返回以下最终验收报告，不要调用工具：\n\n${fs.readFileSync(report.path, "utf8")}`;
            } else {
              const snapshot = this.store.getTaskGroupSnapshot(group.id);
              const blockers = snapshot.work_items
                .filter((item) => item.status === "blocked")
                .map((item) => ({ id: item.id, title: item.title }));
              const failures = snapshot.acceptances
                .filter((acceptance) => acceptance.result === "failed")
                .slice(-3)
                .map((acceptance) => acceptance.failure_reason);
              message = [
                "9codex 持久任务组遇到真实阻断。原样返回以下信息，不要调用工具：",
                JSON.stringify({
                  taskGroupId: group.id,
                  blockingFact: payload.reason || "task group blocked",
                  attemptedActions: failures,
                  affectedScope: blockers,
                  minimumUserDecision: "查看阻断证据并提供缺失凭据、授权或业务裁决。",
                }, null, 2),
              ].join("\n\n");
            }
            const worker = this.codexRuntime.resumeThread(group.origin_thread_id, message, {
              cwd: group.workspace,
              approvalPolicy: "never",
              ignoreUserConfig: false,
            });
            const result = await this.codexRuntime.waitWorker(worker, { timeoutMs: 120_000 });
            if (!result.ok) throw new Error(`task-group notification failed with ${result.code}`);
          }
        }
        this.store.markOutboxPublished(row.id);
        published.push(row.id);
      } catch (error) {
        this.store.markOutboxFailed(row.id, error.message);
        this.onError(error);
      }
    }
    return published;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.scheduler);
    clearInterval(this.backups);
    clearInterval(this.taskCenterBridge);
    await new Promise((resolve) => this.taskboard?.close(resolve) || resolve());
    await Promise.allSettled([...this.supervisions.values()]);
    this.store.close();
  }
}

export async function startTeamRuntime(paths, config, options = {}) {
  const store = options.store || await openTeamStore(paths.teamDatabase);
  const codexRuntime = options.codexRuntime || createCodexRuntime({
    command: options.codexCommand,
  });
  const harnessRuntime = options.harnessRuntime || configuredHarnessRuntime(paths, config);
  const workerEnv = options.workerEnv || prepareWorkerHome(paths, config);
  const verificationEnv = { ...workerEnv };
  const workspaceManager = options.workspaceManager || new WorkspaceRouter(store);
  const planner = options.planner || createTeamPlanner({
    codexRuntime,
    harnessRuntime,
    env: workerEnv,
  });
  const recordWorkerEvent = ({ taskGroupId, workItemId, workerSessionId, runId, event, inspection }) => {
    const activity = workerActivity(event);
    store.recordExternalEvent({
      taskGroupId,
      aggregateType: "worker_runtime",
      aggregateId: workerSessionId,
      eventType: "worker.runtime_activity",
      payload: {
        workItemId,
        workerSessionId,
        runId,
        phase: inspection?.phase || event?.type || "runtime.event",
      },
    });
    if (!activity.text && !activity.command && !activity.output && !activity.files) return;
    store.recordExternalEvent({
      taskGroupId,
      aggregateType: "worker_output",
      aggregateId: workerSessionId,
      eventType: "worker.output",
      payload: {
        workItemId,
        workerSessionId,
        runId,
        activity,
      },
    });
  };
  const orchestrator = options.orchestrator || createTaskOrchestrator({
    store,
    codexRuntime,
    harnessRuntime,
    workspaceManager,
    planner,
    workerOptions: {
      env: workerEnv,
      ignoreUserConfig: false,
      ignoreRules: true,
      sandbox: "workspace-write",
      approvalPolicy: "never",
    },
    verificationSecrets: [
      config.local.token,
      config.team.token,
      config.upstream.api_key,
      config.control_plane?.access_token,
      config.control_plane?.refresh_token,
    ].filter(Boolean),
    verificationEnv,
    onWorkerEvent: recordWorkerEvent,
    publishThread: (input) => publishCodexThread(paths.codexHome, input),
    maxConcurrency: config.team.max_workers,
    leaseTtlMs: Math.max(10, Number(config.team.lease_seconds) || 60) * 1000,
    artifactRoot: paths.artifactsDir,
  });
  return new TeamRuntime({
    paths,
    config,
    store,
    codexRuntime,
    harnessRuntime,
    workspaceManager,
    orchestrator,
    workerEnv,
    workerPreflight: options.workerPreflight,
    defaultWorkspace: options.defaultWorkspace || process.cwd(),
    onError: options.onError || (() => {}),
    repairRuntimeConfig: options.repairRuntimeConfig,
  }).start();
}
