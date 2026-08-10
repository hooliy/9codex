import fs from "node:fs";
import path from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function syncBundledSkills(paths, {
  packageRoot,
  rename = fs.renameSync,
}) {
  const sourceRoot = path.join(packageRoot, "skills");
  const targetRoot = path.join(paths.codexHome, "skills");
  const skills = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      if (!SKILL_NAME.test(entry.name)) {
        throw new Error(`Invalid bundled skill directory name: ${entry.name}`);
      }
      const source = path.join(sourceRoot, entry.name);
      const manifest = path.join(source, "SKILL.md");
      if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile()) {
        throw new Error(`Bundled skill is missing SKILL.md: ${entry.name}`);
      }
      return { name: entry.name, source };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  fs.mkdirSync(targetRoot, { recursive: true });
  for (const skill of skills) {
    const work = fs.mkdtempSync(path.join(targetRoot, ".9codex-sync-"));
    const staging = path.join(work, "staging");
    const backup = path.join(work, "backup");
    const target = path.join(targetRoot, skill.name);
    try {
      fs.cpSync(skill.source, staging, { recursive: true });
      if (fs.existsSync(target)) rename(target, backup);
      rename(staging, target);
      fs.rmSync(work, { recursive: true, force: true });
    } catch (error) {
      if (fs.existsSync(backup)) {
        fs.rmSync(target, { recursive: true, force: true });
        rename(backup, target);
      }
      fs.rmSync(work, { recursive: true, force: true });
      throw error;
    }
  }
  return skills.map((skill) => skill.name);
}
