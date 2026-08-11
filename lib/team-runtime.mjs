import fs from "node:fs";
import path from "node:path";

import { createCodexAdapter } from "./codex-adapter.mjs";
import { createTaskOrchestrator } from "./task-orchestrator.mjs";
import { startTaskboard } from "./taskboard.mjs";
import { openTeamStore } from "./team-store.mjs";
import { createTeamPlanner } from "./team-planner.mjs";
import { createWorkspaceManager } from "./workspace-manager.mjs";

const ACTIVE_GROUPS = new Set(["planning", "executing", "integrating", "verifying"]);

function tomlString(value) {
  return JSON.stringify(String(value));
}

function prepareWorkerHome(paths, config) {
  const workerHome = path.join(paths.stateDir, "team-codex-home");
  fs.mkdirSync(workerHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(workerHome, 0o700);
  fs.writeFileSync(path.join(workerHome, "config.toml"), [
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
  return {
    ...Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    HOME: workerHome,
    CODEX_HOME: workerHome,
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
    const event = events[index];
    const text = event?.item?.content?.map?.((part) => part?.text).filter(Boolean).join("\n")
      || event?.message?.content
      || event?.last_message
      || event?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function redactEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => ![
    "authorization", "api_key", "body", "input", "messages",
  ].includes(key)));
}

export class TeamRuntime {
  constructor(options) {
    Object.assign(this, options);
    this.supervisions = new Map();
    this.closed = false;
  }

  async start() {
    const recovered = await this.orchestrator.recover({ recoverAllRunning: true });
    for (const assignment of recovered.started || []) this.#supervise(assignment);
    this.taskboard = await startTaskboard({
      host: this.config.team.host,
      port: this.config.team.port,
      token: this.config.team.token,
      store: this.store,
      orchestrator: this.orchestrator,
      onError: this.onError,
    });
    this.scheduler = setInterval(() => void this.tick().catch(this.onError), 1000);
    this.scheduler.unref();
    this.backups = setInterval(
      () => void this.backup().catch(this.onError),
      Math.max(60, Number(this.config.team.backup_interval_seconds) || 3600) * 1000,
    );
    this.backups.unref();
    await this.tick();
    return this;
  }

  async tick() {
    if (this.closed) return;
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

  #supervise(assignment) {
    if (!assignment.workerId || this.supervisions.has(assignment.workerSessionId)) return;
    const promise = (async () => {
      const watchdog = setInterval(() => {
        const worker = this.adapter.workers?.get?.(assignment.workerId);
        const timeoutMs = Number(this.orchestrator.heartbeatTimeoutMs) || 60_000;
        if (worker && Date.now() - worker.lastEventAt > timeoutMs) {
          this.adapter.interruptWorker(worker);
        }
      }, Math.max(1000, Math.floor((Number(this.orchestrator.heartbeatTimeoutMs) || 60_000) / 4)));
      watchdog.unref();
      try {
        const result = await this.adapter.waitWorker(assignment.workerId);
        const events = this.adapter.readEvents(assignment.workerId);
        const worker = this.adapter.workers?.get?.(assignment.workerId);
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
          await this.orchestrator.failWorker({
            workerSessionId: assignment.workerSessionId,
            runId: assignment.runId,
            failure: {
              type: "worker_process",
              exitCode: result.code,
              signal: result.signal,
              events: events.filter((event) => event.type === "adapter.stderr").map((event) => event.text),
            },
          });
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
            knownRisks: result.ok ? [] : [`Codex exited with ${result.code}`],
            nextStep: "Independent verification",
          },
        });
      } catch (error) {
        this.onError(error);
        try {
          await this.orchestrator.reportWorker({
            workerSessionId: assignment.workerSessionId,
            runId: assignment.runId,
            report: { error: error.message },
          });
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
    const published = [];
    for (const row of this.store.pendingOutbox(100)) {
      try {
        const payload = row.payload || {};
        if (
          row.topic === "task_group.status_changed"
          && ["blocked", "done"].includes(payload.to)
          && typeof this.adapter.resumeThread === "function"
        ) {
          const group = this.store.get("task_groups", payload.taskGroupId);
          if (group) {
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
            const worker = this.adapter.resumeThread(group.origin_thread_id, message, {
              cwd: group.workspace,
              approvalPolicy: "never",
              ignoreUserConfig: false,
            });
            const result = await this.adapter.waitWorker(worker, { timeoutMs: 120_000 });
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
    await new Promise((resolve) => this.taskboard?.close(resolve) || resolve());
    await Promise.allSettled([...this.supervisions.values()]);
    this.store.close();
  }
}

export async function startTeamRuntime(paths, config, options = {}) {
  const store = options.store || await openTeamStore(paths.teamDatabase);
  const adapter = options.adapter || createCodexAdapter({
    command: options.codexCommand,
  });
  const workerEnv = options.workerEnv || prepareWorkerHome(paths, config);
  const workspaceManager = options.workspaceManager || new WorkspaceRouter(store);
  const planner = options.planner || createTeamPlanner({ adapter, env: workerEnv });
  const orchestrator = options.orchestrator || createTaskOrchestrator({
    store,
    adapter,
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
    maxConcurrency: config.team.max_workers,
    leaseTtlMs: Math.max(10, Number(config.team.lease_seconds) || 60) * 1000,
    artifactRoot: paths.artifactsDir,
  });
  return new TeamRuntime({
    paths,
    config,
    store,
    adapter,
    workspaceManager,
    orchestrator,
    defaultWorkspace: options.defaultWorkspace || process.cwd(),
    onError: options.onError || (() => {}),
  }).start();
}
