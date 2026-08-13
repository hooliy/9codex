import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkspaceError";
    Object.assign(this, details);
  }
}

function git(cwd, args, options = {}) {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return Buffer.isBuffer(output) ? output : output.trim();
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    throw new WorkspaceError(stderr || error.message, {
      command: ["git", "-C", cwd, ...args],
      cause: error,
    });
  }
}

function list(value) {
  return [...new Set((value || []).map((item) => String(item).trim()).filter(Boolean))];
}

function field(value, snake, camel) {
  return value?.[snake] ?? value?.[camel];
}

function normalizePattern(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new WorkspaceError(`Invalid workspace path pattern: ${value}`);
  }
  return normalized.replace(/\/$/, "");
}

function normalizePatterns(values) {
  return list(values).map(normalizePattern).sort();
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}(?:/.*)?$`);
}

function staticPrefix(pattern) {
  const wildcard = pattern.search(/[*?[]/);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/+$/, "");
}

function patternMatches(pattern, file) {
  if (!/[*?[]/.test(pattern)) return file === pattern || file.startsWith(`${pattern}/`);
  return globRegex(pattern).test(file);
}

function patternsOverlap(left, right) {
  if (patternMatches(left, right) || patternMatches(right, left)) return true;
  const a = staticPrefix(left);
  const b = staticPrefix(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function intersections(left, right) {
  const found = [];
  for (const a of left) {
    for (const b of right) {
      if (patternsOverlap(a, b)) found.push([a, b]);
    }
  }
  return found;
}

function safeSegment(value, label) {
  const segment = String(value || "");
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new WorkspaceError(`Invalid ${label}: ${value}`);
  }
  return segment;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function branchExists(repo, branch) {
  try {
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function changedFiles(worktree, baseCommit) {
  const committed = baseCommit
    ? git(worktree, ["diff", "--name-only", "-z", `${baseCommit}...HEAD`, "--"], { encoding: "buffer" })
    : Buffer.alloc(0);
  const tracked = git(worktree, ["diff", "--name-only", "-z", "HEAD", "--"], { encoding: "buffer" });
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return [...new Set(
    Buffer.concat([
      Buffer.isBuffer(committed) ? committed : Buffer.from(committed),
      Buffer.isBuffer(tracked) ? tracked : Buffer.from(tracked),
      Buffer.isBuffer(untracked) ? untracked : Buffer.from(untracked),
    ]).toString("utf8").split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/")),
  )].sort();
}

function workingTreeStatus(worktree, excludeInternal = false) {
  return git(worktree, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ...(excludeInternal ? [":(exclude).9codex"] : []),
  ]);
}

function worktrees(repo) {
  const records = [];
  let current = {};
  for (const line of `${git(repo, ["worktree", "list", "--porcelain"])}\n`.split("\n")) {
    if (!line) {
      if (current.worktree) records.push(current);
      current = {};
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? true : line.slice(space + 1);
    current[key] = value;
  }
  return records;
}

function topological(items) {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  if (byId.size !== items.length) throw new WorkspaceError("Merge items require unique ids");
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (item) => {
    const id = String(item.id);
    if (visiting.has(id)) throw new WorkspaceError(`Merge dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of list(field(item, "merge_dependencies", "mergeDependencies") ?? item.dependencies)) {
      const required = byId.get(String(dependency));
      if (required) visit(required);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(item);
  };
  items.forEach(visit);
  return ordered;
}

export class WorkspaceManager {
  constructor(repo) {
    this.repo = fs.realpathSync(repo);
    if (git(this.repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
      throw new WorkspaceError(`Not a git worktree: ${repo}`);
    }
    const common = git(this.repo, ["rev-parse", "--git-common-dir"]);
    this.gitDir = fs.realpathSync(path.resolve(this.repo, common));
    this.root = path.join(this.repo, ".9codex", "worktrees");
    this.stateFile = path.join(this.gitDir, "9codex-workspace-manager.json");
    this.stateLock = `${this.stateFile}.lock`;
    this.evidenceRoot = path.join(this.gitDir, "9codex-evidence");
    fs.mkdirSync(this.evidenceRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.evidenceRoot, 0o700);
    this.defaultBranch = git(this.repo, ["branch", "--show-current"]);
    const exclude = path.join(this.gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const contents = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!contents.split(/\r?\n/).includes(".9codex/")) {
      fs.appendFileSync(exclude, `${contents && !contents.endsWith("\n") ? "\n" : ""}.9codex/\n`);
    }
  }

  workspacePath(taskGroup, workItem) {
    return path.join(
      this.root,
      safeSegment(taskGroup, "task-group"),
      safeSegment(workItem, "work-item"),
    );
  }

  #state() {
    return readJson(this.stateFile, { version: 1, claims: {}, worktrees: {} });
  }

  #mutate(callback) {
    fs.mkdirSync(path.dirname(this.stateLock), { recursive: true, mode: 0o700 });
    let descriptor;
    try {
      descriptor = fs.openSync(this.stateLock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new WorkspaceError("Workspace state is locked");
      throw error;
    }
    try {
      const state = this.#state();
      const result = callback(state);
      atomicJson(this.stateFile, state);
      return result;
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
      try { fs.unlinkSync(this.stateLock); } catch {}
    }
  }

  checkConflicts(owner, claim = {}) {
    const candidate = {
      write_set: normalizePatterns(field(claim, "write_set", "writeSet")),
      read_set: normalizePatterns(field(claim, "read_set", "readSet")),
      resource_locks: list(field(claim, "resource_locks", "resourceLocks")).sort(),
    };
    const conflicts = [];
    for (const [heldBy, held] of Object.entries(this.#state().claims)) {
      if (heldBy === String(owner)) continue;
      const writeWrite = intersections(candidate.write_set, held.write_set || []);
      const writeRead = intersections(candidate.write_set, held.read_set || []);
      const readWrite = intersections(candidate.read_set, held.write_set || []);
      const resources = candidate.resource_locks.filter((resource) => (held.resource_locks || []).includes(resource));
      if (writeWrite.length || writeRead.length || readWrite.length || resources.length) {
        conflicts.push({ held_by: heldBy, write_write: writeWrite, write_read: writeRead, read_write: readWrite, resource_locks: resources });
      }
    }
    return conflicts;
  }

  hold(owner, claim = {}) {
    const id = String(owner || "");
    if (!id) throw new WorkspaceError("Claim owner is required");
    const normalized = {
      write_set: normalizePatterns(field(claim, "write_set", "writeSet")),
      read_set: normalizePatterns(field(claim, "read_set", "readSet")),
      resource_locks: list(field(claim, "resource_locks", "resourceLocks")).sort(),
      acquired_at: new Date().toISOString(),
    };
    return this.#mutate((state) => {
      const previous = state.claims[id];
      delete state.claims[id];
      const conflicts = this.checkConflicts(id, normalized);
      if (conflicts.length) {
        if (previous) state.claims[id] = previous;
        throw new WorkspaceError("Workspace claim conflicts with an active claim", { conflicts });
      }
      state.claims[id] = normalized;
      return normalized;
    });
  }

  release(owner) {
    return this.#mutate((state) => delete state.claims[String(owner)]);
  }

  createWorktree(options) {
    const taskGroup = field(options, "task_group", "taskGroup");
    const workItem = field(options, "work_item", "workItem");
    const branch = String(options.branch || "");
    const startPoint = field(options, "start_point", "startPoint") || "HEAD";
    const destination = this.workspacePath(taskGroup, workItem);
    if (!branch) throw new WorkspaceError("Worktree branch is required");
    git(this.repo, ["check-ref-format", "--branch", branch]);
    if (fs.existsSync(destination)) return this.restoreWorktree(options);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const baseCommit = branchExists(this.repo, branch)
      ? git(this.repo, ["merge-base", String(startPoint), branch])
      : git(this.repo, ["rev-parse", String(startPoint)]);
    if (branchExists(this.repo, branch)) {
      git(this.repo, ["worktree", "add", destination, branch]);
    } else {
      git(this.repo, ["worktree", "add", "-b", branch, destination, String(startPoint)]);
    }
    const record = {
      task_group: String(taskGroup),
      work_item: String(workItem),
      branch,
      worktree: destination,
      base_commit: baseCommit,
    };
    this.#mutate((state) => { state.worktrees[String(workItem)] = record; });
    return this.checkWorktree(record);
  }

  restoreWorktree(options) {
    const taskGroup = field(options, "task_group", "taskGroup");
    const workItem = field(options, "work_item", "workItem");
    const destination = this.workspacePath(taskGroup, workItem);
    const branch = options.branch || this.#state().worktrees[String(workItem)]?.branch;
    if (fs.existsSync(destination)) {
      try {
        return this.checkWorktree({ ...options, worktree: destination });
      } catch {
        git(this.repo, ["worktree", "repair", destination]);
        return this.checkWorktree({ ...options, worktree: destination });
      }
    }
    if (!branch) throw new WorkspaceError(`No branch recorded for work item ${workItem}`);
    if (!branchExists(this.repo, branch)) throw new WorkspaceError(`Branch not found: ${branch}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    git(this.repo, ["worktree", "prune"]);
    git(this.repo, ["worktree", "add", destination, branch]);
    return this.checkWorktree({ ...options, worktree: destination });
  }

  checkWorktree(options) {
    const destination = options.worktree || this.workspacePath(
      field(options, "task_group", "taskGroup"),
      field(options, "work_item", "workItem"),
    );
    if (!fs.existsSync(destination)) return { exists: false, worktree: destination };
    const common = path.resolve(destination, git(destination, ["rev-parse", "--git-common-dir"]));
    if (fs.realpathSync(common) !== this.gitDir) throw new WorkspaceError(`Foreign worktree: ${destination}`);
    const branchRef = git(destination, ["symbolic-ref", "--quiet", "HEAD"]);
    const status = workingTreeStatus(destination);
    const record = Object.values(this.#state().worktrees).find((item) => item.worktree === destination);
    return {
      exists: true,
      clean: status === "",
      branch: branchRef.replace(/^refs\/heads\//, ""),
      worktree: destination,
      changed_files: changedFiles(destination, field(options, "base_commit", "baseCommit") || record?.base_commit),
      status,
    };
  }

  detectOutOfScopeChanges(options) {
    const destination = options.worktree || this.workspacePath(
      field(options, "task_group", "taskGroup"),
      field(options, "work_item", "workItem"),
    );
    const allowed = normalizePatterns(field(options, "write_set", "writeSet"));
    const record = Object.values(this.#state().worktrees).find((item) => item.worktree === destination);
    const baseCommit = field(options, "base_commit", "baseCommit") || record?.base_commit;
    const ignored = new Set(list(field(options, "ignored_files", "ignoredFiles")));
    return changedFiles(destination, baseCommit).filter(
      (file) => !ignored.has(file) && !allowed.some((pattern) => patternMatches(pattern, file)),
    );
  }

  assertWriteScope(options) {
    const outside = this.detectOutOfScopeChanges(options);
    if (outside.length) throw new WorkspaceError("Changed files exceed write_set", { changed_files: outside });
    return true;
  }

  commitWorktree(options) {
    const worktree = fs.realpathSync(options.worktree);
    const ignored = new Set(list(field(options, "ignored_files", "ignoredFiles")));
    this.assertWriteScope({
      worktree,
      writeSet: field(options, "write_set", "writeSet") || [],
      ignoredFiles: [...ignored],
    });
    const files = changedFiles(worktree).filter((file) => !ignored.has(file));
    if (files.length === 0) {
      return {
        committed: false,
        head: git(worktree, ["rev-parse", "HEAD"]),
        changed_files: [],
      };
    }
    git(worktree, ["add", "--all", "--", ...files]);
    git(worktree, [
      "-c", "user.name=9codex",
      "-c", "user.email=9codex@localhost",
      "commit", "-m", options.message || `9codex: complete ${field(options, "work_item", "workItem") || "work item"}`,
    ]);
    return {
      committed: true,
      head: git(worktree, ["rev-parse", "HEAD"]),
      changed_files: files,
    };
  }

  preserveEvidence(label, worktree, error) {
    const directory = path.join(
      this.evidenceRoot,
      `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${safeSegment(label, "evidence label")}-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const commands = {
      status: ["status", "--porcelain=v1", "--untracked-files=all"],
      head: ["rev-parse", "HEAD"],
      log: ["log", "--oneline", "--decorate", "-20"],
      diff: ["diff", "--binary"],
      staged: ["diff", "--cached", "--binary"],
    };
    for (const [name, args] of Object.entries(commands)) {
      try { fs.writeFileSync(path.join(directory, `${name}.txt`), `${git(worktree, args)}\n`, { mode: 0o600 }); } catch {}
    }
    atomicJson(path.join(directory, "failure.json"), {
      message: error?.message || String(error),
      command: error?.command,
      created_at: new Date().toISOString(),
      worktree,
    });
    return directory;
  }

  deleteWorktree(options) {
    const destination = options.worktree || this.workspacePath(
      field(options, "task_group", "taskGroup"),
      field(options, "work_item", "workItem"),
    );
    if (!fs.existsSync(destination)) {
      git(this.repo, ["worktree", "prune"]);
      return { deleted: false, worktree: destination };
    }
    const check = this.checkWorktree({ worktree: destination });
    let evidence;
    if (!check.clean) {
      evidence = this.preserveEvidence(field(options, "work_item", "workItem") || "worktree", destination, new Error("Dirty worktree cleanup"));
      if (!options.force) throw new WorkspaceError("Refusing to delete dirty worktree", { evidence_path: evidence, changed_files: check.changed_files });
    }
    git(this.repo, ["worktree", "remove", ...(options.force ? ["--force"] : []), destination]);
    git(this.repo, ["worktree", "prune"]);
    this.#mutate((state) => {
      for (const [id, record] of Object.entries(state.worktrees)) {
        if (record.worktree === destination) delete state.worktrees[id];
      }
    });
    return { deleted: true, worktree: destination, evidence_path: evidence };
  }

  async mergeAccepted(options) {
    const targetBranch = field(options, "target_branch", "targetBranch") || this.defaultBranch;
    const items = topological(options.items || []);
    if (items.length && typeof options.runTests !== "function") {
      throw new WorkspaceError("runTests is required to verify each merged work item");
    }
    for (const item of items) {
      if (!(item.accepted === true || ["accepted", "passed"].includes(item.status))) {
        throw new WorkspaceError(`Work item is not accepted: ${item.id}`);
      }
      if (!item.branch || !branchExists(this.repo, item.branch)) {
        throw new WorkspaceError(`Accepted branch not found: ${item.branch}`);
      }
    }
    if (!branchExists(this.repo, targetBranch)) throw new WorkspaceError(`Target branch not found: ${targetBranch}`);
    const targetRef = `refs/heads/${targetBranch}`;
    const originalHead = git(this.repo, ["rev-parse", targetRef]);
    const targetWorktree = worktrees(this.repo).find((entry) => entry.branch === targetRef)?.worktree;
    if (targetWorktree && workingTreeStatus(targetWorktree, true)) {
      throw new WorkspaceError(`Target worktree is dirty: ${targetWorktree}`);
    }

    const token = crypto.randomUUID();
    const integrationBranch = `9codex/integration/${token}`;
    const taskGroup = safeSegment(field(options, "task_group", "taskGroup") || "integration", "task-group");
    const integrationPath = this.workspacePath(taskGroup, `.merge-${token}`);
    fs.mkdirSync(path.dirname(integrationPath), { recursive: true, mode: 0o700 });
    git(this.repo, ["worktree", "add", "-b", integrationBranch, integrationPath, originalHead]);
    let failedItem;
    try {
      for (const item of items) {
        failedItem = item;
        git(integrationPath, ["merge", "--no-edit", "--no-ff", item.branch]);
        const result = await options.runTests?.({ item, worktree: integrationPath });
        if (result === false || (Number.isInteger(result?.status) && result.status !== 0)) {
          throw new WorkspaceError(`Affected tests failed after merging ${item.id}`);
        }
      }
      const integratedHead = git(integrationPath, ["rev-parse", "HEAD"]);
      if (git(this.repo, ["rev-parse", targetRef]) !== originalHead) {
        throw new WorkspaceError(`Target branch moved during integration: ${targetBranch}`);
      }
      if (targetWorktree) {
        git(targetWorktree, ["merge", "--ff-only", integratedHead]);
      } else {
        git(this.repo, ["update-ref", targetRef, integratedHead, originalHead]);
      }
      git(this.repo, ["worktree", "remove", integrationPath]);
      git(this.repo, ["branch", "-D", integrationBranch]);
      return { target_branch: targetBranch, head: integratedHead, merged: items.map((item) => item.id) };
    } catch (error) {
      const evidence = this.preserveEvidence(failedItem?.id || "integration", integrationPath, error);
      try { git(integrationPath, ["merge", "--abort"]); } catch {}
      try { git(this.repo, ["worktree", "remove", "--force", integrationPath]); } catch {}
      throw new WorkspaceError(`Integration failed${failedItem ? ` at ${failedItem.id}` : ""}: ${error.message}`, {
        cause: error,
        failed_item: failedItem?.id,
        evidence_path: evidence,
        target_head: originalHead,
      });
    }
  }
}

export function createWorkspaceManager(repo) {
  return new WorkspaceManager(repo);
}

export const acquireWorkspaceClaim = (manager, owner, claim) => manager.hold(owner, claim);
export const releaseWorkspaceClaim = (manager, owner) => manager.release(owner);
