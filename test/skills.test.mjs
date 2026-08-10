import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncBundledSkills } from "../lib/skills.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-skills-test-"));
  const packageRoot = path.join(root, "package");
  const codexHome = path.join(root, "home", ".codex");
  fs.mkdirSync(path.join(packageRoot, "skills", "orchestrator"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "skills", "orchestrator", "SKILL.md"),
    "# Orchestrator\n",
  );
  return { packageRoot, paths: { codexHome } };
}

test("syncs bundled skills into an empty Codex home", () => {
  const { packageRoot, paths } = fixture();

  const synced = syncBundledSkills(paths, { packageRoot });

  assert.deepEqual(synced, ["orchestrator"]);
  assert.equal(
    fs.readFileSync(
      path.join(paths.codexHome, "skills", "orchestrator", "SKILL.md"),
      "utf8",
    ),
    "# Orchestrator\n",
  );
});

test("replaces an installed skill completely and removes stale files", () => {
  const { packageRoot, paths } = fixture();
  const installed = path.join(paths.codexHome, "skills", "orchestrator");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "SKILL.md"), "# Old\n");
  fs.writeFileSync(path.join(installed, "stale.txt"), "remove me");

  syncBundledSkills(paths, { packageRoot });

  assert.equal(fs.readFileSync(path.join(installed, "SKILL.md"), "utf8"), "# Orchestrator\n");
  assert.equal(fs.existsSync(path.join(installed, "stale.txt")), false);
});

test("preserves unrelated user skills", () => {
  const { packageRoot, paths } = fixture();
  const userSkill = path.join(paths.codexHome, "skills", "user-owned");
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# User\n");

  syncBundledSkills(paths, { packageRoot });

  assert.equal(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf8"), "# User\n");
});

test("copies nested bundled skill resources", () => {
  const { packageRoot, paths } = fixture();
  const resource = path.join(
    packageRoot,
    "skills",
    "orchestrator",
    "references",
    "workflow.md",
  );
  fs.mkdirSync(path.dirname(resource), { recursive: true });
  fs.writeFileSync(resource, "supervise and verify\n");

  syncBundledSkills(paths, { packageRoot });

  assert.equal(
    fs.readFileSync(
      path.join(
        paths.codexHome,
        "skills",
        "orchestrator",
        "references",
        "workflow.md",
      ),
      "utf8",
    ),
    "supervise and verify\n",
  );
});

test("restores the original skill when replacement fails", () => {
  const { packageRoot, paths } = fixture();
  const installed = path.join(paths.codexHome, "skills", "orchestrator");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "SKILL.md"), "# Original\n");
  fs.writeFileSync(path.join(installed, "original.txt"), "keep me");

  assert.throws(
    () => syncBundledSkills(paths, {
      packageRoot,
      rename(from, to) {
        if (path.basename(from) === "staging" && to === installed) {
          throw new Error("injected replacement failure");
        }
        fs.renameSync(from, to);
      },
    }),
    /injected replacement failure/,
  );

  assert.equal(fs.readFileSync(path.join(installed, "SKILL.md"), "utf8"), "# Original\n");
  assert.equal(fs.readFileSync(path.join(installed, "original.txt"), "utf8"), "keep me");
  assert.deepEqual(
    fs.readdirSync(path.join(paths.codexHome, "skills"))
      .filter((name) => name.startsWith(".9codex-sync-")),
    [],
  );
});

test("rejects invalid bundled skill directories before writing", () => {
  const { packageRoot, paths } = fixture();
  fs.mkdirSync(path.join(packageRoot, "skills", "Invalid Name"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "skills", "Invalid Name", "SKILL.md"),
    "# Invalid\n",
  );

  assert.throws(
    () => syncBundledSkills(paths, { packageRoot }),
    /Invalid bundled skill directory name: Invalid Name/,
  );
  assert.equal(fs.existsSync(path.join(paths.codexHome, "skills")), false);
});

test("rejects bundled skill directories without SKILL.md before writing", () => {
  const { packageRoot, paths } = fixture();
  fs.mkdirSync(path.join(packageRoot, "skills", "missing-manifest"));

  assert.throws(
    () => syncBundledSkills(paths, { packageRoot }),
    /Bundled skill is missing SKILL\.md: missing-manifest/,
  );
  assert.equal(fs.existsSync(path.join(paths.codexHome, "skills")), false);
});
