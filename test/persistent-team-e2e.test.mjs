import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskOrchestrator } from "../lib/task-orchestrator.mjs";
import { openTeamStore } from "../lib/team-store.mjs";
import { createWorkspaceManager } from "../lib/workspace-manager.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

class Runtime {
  constructor(runtimeKind = "codex") {
    this.runtime_kind = runtimeKind;
    this.created = [];
    this.workers = new Map();
  }
  createWorker(instruction, { cwd }) {
    const number = this.created.length + 1;
    const worker = {
      id: `worker-${number}`,
      sessionId: `${this.runtime_kind}-session-${number}`,
      instruction,
      cwd,
    };
    this.created.push(worker);
    this.workers.set(worker.id, worker);
    return worker;
  }
  async createThread(instruction, options) { return this.createWorker(instruction, options); }
  resumeThread(sessionId, instruction, options) {
    const worker = this.createWorker(instruction, options);
    worker.sessionId = sessionId;
    return worker;
  }
  interruptWorker() { return true; }
  async closeWorker() { return { ok: true }; }
  forgetWorker(worker) { return this.workers.delete(worker.id); }
}

test("real Git vertical loop confirms, executes, reviews, commits, integrates, cleans, and completes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-team-e2e-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "E2E Test");
  git(repo, "config", "user.email", "e2e@example.test");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }));
  fs.mkdirSync(path.join(repo, "test"));
  fs.writeFileSync(path.join(repo, "test", "feature.test.mjs"), `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import test from "node:test";
    test("feature exists", () => assert.equal(fs.readFileSync(new URL("../feature.txt", import.meta.url), "utf8"), "done\\n"));
  `);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");

  const store = await openTeamStore(path.join(root, "state", "team.sqlite"));
  t.after(() => { try { store.close(); } catch {} });
  const codexRuntime = new Runtime();
  const harnessRuntime = new Runtime("deepseek-harness");
  const workspaceManager = createWorkspaceManager(repo);
  const orchestrator = createTaskOrchestrator({
    store,
    codexRuntime,
    harnessRuntime,
    workspaceManager,
    artifactRoot: path.join(root, "state", "artifacts"),
    classifier: async () => ({ type: "new_requirement", confidence: 0.9, highImpact: false }),
    planner: async () => ({
      summary: "Create feature.txt",
      questions: [],
      requirements: [{
        key: "feature",
        requirementId: null,
        title: "Feature",
        normalizedRequirement: "Create feature.txt",
        acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
        impactSummary: "new feature",
        impactActions: [],
        workItems: [{
          key: "feature",
          title: "Create feature",
          description: "Create feature.txt containing done",
          priority: 0,
          writeSet: ["feature.txt"],
          readSet: [],
          resourceLocks: [],
          dependencies: [],
          acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
        }],
      }],
    }),
  });

  const waiting = await orchestrator.ingestDemand({
    threadId: "origin-thread",
    sourceMessageId: "message-1",
    content: "Create feature.txt",
    workspace: repo,
  });
  assert.equal(waiting.status, "awaiting_confirmation");
  const demand = await orchestrator.confirmDemand({ eventKey: "origin-thread:message-1", approved: true });
  const [assignment] = await orchestrator.schedule(demand.taskGroupId);
  fs.writeFileSync(path.join(assignment.handoff.workspace, "feature.txt"), "done\n");

  const result = await orchestrator.reportWorker({
    workerSessionId: assignment.workerSessionId,
    runId: assignment.runId,
    report: { summary: "created feature.txt" },
  });

  assert.equal(result.result, "passed");
  assert.equal(result.finalReport.finalDecision, "passed");
  assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "done\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(assignment.handoff.workspace), false);
  assert.equal(store.get("task_groups", demand.taskGroupId).status, "done");
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runs WHERE role='reviewer' AND status='passed'").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM runs WHERE role='integrator' AND status='passed'").get().count, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM evidence WHERE type='commit'").get().count, 1);
});
