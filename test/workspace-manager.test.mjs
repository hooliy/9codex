import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceError, WorkspaceManager } from "../lib/workspace-manager.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-workspace-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Workspace Test");
  git(repo, "config", "user.email", "workspace@example.test");
  fs.mkdirSync(path.join(repo, "lib"));
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  fs.writeFileSync(path.join(repo, "lib", "base.mjs"), "export const base = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return { repo, manager: new WorkspaceManager(repo) };
}

function commit(worktree, file, contents, message) {
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(worktree, file), contents);
  git(worktree, "add", file);
  git(worktree, "commit", "-m", message);
}

test("creates, checks, restores, and safely deletes an independent worktree", () => {
  const { repo, manager } = fixture();
  const created = manager.createWorktree({
    task_group: "group-1",
    work_item: "item-1",
    branch: "work/item-1",
  });

  assert.equal(created.exists, true);
  assert.equal(created.clean, true);
  assert.equal(created.branch, "work/item-1");
  assert.equal(fs.realpathSync(created.worktree), fs.realpathSync(path.join(repo, ".9codex", "worktrees", "group-1", "item-1")));
  assert.notEqual(fs.realpathSync(created.worktree), fs.realpathSync(repo));
  assert.equal(manager.restoreWorktree({ task_group: "group-1", work_item: "item-1" }).worktree, created.worktree);
  fs.rmSync(created.worktree, { recursive: true, force: true });
  assert.equal(manager.restoreWorktree({ task_group: "group-1", work_item: "item-1" }).worktree, created.worktree);

  fs.writeFileSync(path.join(created.worktree, "dirty.txt"), "evidence\n");
  assert.throws(
    () => manager.deleteWorktree({ task_group: "group-1", work_item: "item-1" }),
    (error) => error instanceof WorkspaceError
      && /dirty worktree/.test(error.message)
      && fs.existsSync(error.evidence_path)
      && fs.existsSync(created.worktree),
  );
  const removed = manager.deleteWorktree({ task_group: "group-1", work_item: "item-1", force: true });
  assert.equal(removed.deleted, true);
  assert.equal(fs.existsSync(created.worktree), false);
});

test("rejects overlapping write sets and write/read conflicts but allows disjoint readers", () => {
  const { manager } = fixture();
  manager.hold("writer", { write_set: ["lib/**"], read_set: ["README.md"] });

  assert.throws(
    () => manager.hold("overlap", { write_set: ["lib/base.mjs"] }),
    (error) => error instanceof WorkspaceError
      && error.conflicts[0].write_write.length === 1,
  );
  assert.throws(
    () => manager.hold("reader", { read_set: ["lib/base.mjs"] }),
    (error) => error.conflicts[0].read_write.length === 1,
  );
  assert.throws(
    () => manager.hold("read-target-writer", { write_set: ["README.md"] }),
    (error) => error.conflicts[0].write_read.length === 1,
  );
  assert.deepEqual(manager.hold("disjoint-reader", { read_set: ["docs/**"] }).read_set, ["docs/**"]);
  assert.equal(manager.release("writer"), true);
  assert.deepEqual(manager.hold("formerly-blocked", { write_set: ["lib/base.mjs"] }).write_set, ["lib/base.mjs"]);
});

test("resource locks are exclusive and released by owner", () => {
  const { manager } = fixture();
  manager.hold("one", { resource_locks: ["port:4317", "database:test"] });
  assert.throws(
    () => manager.hold("two", { resource_locks: ["port:4317"] }),
    (error) => error.conflicts[0].resource_locks[0] === "port:4317",
  );
  manager.release("one");
  assert.deepEqual(manager.hold("two", { resource_locks: ["port:4317"] }).resource_locks, ["port:4317"]);
});

test("detects tracked and untracked changes outside write_set", () => {
  const { manager } = fixture();
  const workspace = manager.createWorktree({
    taskGroup: "scope",
    workItem: "worker",
    branch: "work/scope",
  }).worktree;
  fs.writeFileSync(path.join(workspace, "lib", "base.mjs"), "export const base = false;\n");
  fs.writeFileSync(path.join(workspace, "README.md"), "outside\n");
  fs.mkdirSync(path.join(workspace, "lib", "new"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "lib", "new", "ok.mjs"), "ok\n");

  assert.deepEqual(
    manager.detectOutOfScopeChanges({ worktree: workspace, write_set: ["lib/**"] }),
    ["README.md"],
  );
  assert.throws(
    () => manager.assertWriteScope({ worktree: workspace, writeSet: ["lib/**"] }),
    (error) => error.changed_files[0] === "README.md",
  );
});

test("detects committed changes outside write_set", () => {
  const { manager } = fixture();
  const workspace = manager.createWorktree({
    task_group: "scope",
    work_item: "committed",
    branch: "work/committed-scope",
  }).worktree;
  commit(workspace, "README.md", "committed outside\n", "outside");

  assert.deepEqual(
    manager.detectOutOfScopeChanges({ worktree: workspace, write_set: ["lib/**"] }),
    ["README.md"],
  );
});

test("commits only write-set changes before integration", () => {
  const { repo, manager } = fixture();
  const created = manager.createWorktree({
    taskGroup: "tg-commit",
    workItem: "wi-commit",
    branch: "feature/commit",
  });
  fs.writeFileSync(path.join(created.worktree, "allowed.txt"), "allowed\n");

  const result = manager.commitWorktree({
    workItem: "wi-commit",
    worktree: created.worktree,
    writeSet: ["allowed.txt"],
  });

  assert.equal(result.committed, true);
  assert.deepEqual(result.changed_files, ["allowed.txt"]);
  assert.equal(git(created.worktree, "status", "--short"), "");
  assert.equal(git(created.worktree, "show", "--format=", "--name-only", "HEAD"), "allowed.txt");
});

test("merges accepted branches in dependency order without checking out main elsewhere", async () => {
  const { repo, manager } = fixture();
  const first = manager.createWorktree({
    task_group: "merge",
    work_item: "first",
    branch: "work/first",
  }).worktree;
  commit(first, "first.txt", "first\n", "first");
  const second = manager.createWorktree({
    task_group: "merge",
    work_item: "second",
    branch: "work/second",
  }).worktree;
  git(second, "merge", "--ff-only", "work/first");
  commit(second, "second.txt", "second\n", "second");
  const order = [];

  const result = await manager.mergeAccepted({
    task_group: "merge",
    target_branch: "main",
    items: [
      { id: "second", branch: "work/second", accepted: true, merge_dependencies: ["first"] },
      { id: "first", branch: "work/first", status: "accepted" },
    ],
    runTests: ({ item, worktree }) => {
      order.push(item.id);
      assert.equal(git(worktree, "status", "--porcelain"), "");
      return true;
    },
  });

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(result.merged, ["first", "second"]);
  assert.equal(fs.readFileSync(path.join(repo, "first.txt"), "utf8"), "first\n");
  assert.equal(fs.readFileSync(path.join(repo, "second.txt"), "utf8"), "second\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("failed integration preserves evidence and leaves main unchanged", async () => {
  const { repo, manager } = fixture();
  const workspace = manager.createWorktree({
    task_group: "failure",
    work_item: "candidate",
    branch: "work/failure",
  }).worktree;
  commit(workspace, "candidate.txt", "candidate\n", "candidate");
  const before = git(repo, "rev-parse", "main");

  await assert.rejects(
    () => manager.mergeAccepted({
      task_group: "failure",
      target_branch: "main",
      items: [{ id: "candidate", branch: "work/failure", accepted: true }],
      runTests: () => false,
    }),
    (error) => error instanceof WorkspaceError
      && error.failed_item === "candidate"
      && fs.existsSync(path.join(error.evidence_path, "failure.json")),
  );
  assert.equal(git(repo, "rev-parse", "main"), before);
  assert.equal(fs.existsSync(path.join(repo, "candidate.txt")), false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});
