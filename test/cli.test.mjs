import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { defaultConfig, saveConfigAtomic } from "../lib/config.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const cli = path.resolve("bin/9codex.mjs");
const packageVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version;

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NINECODEX_HOME: home },
  });
}

test("version reports the package version", () => {
  const result = run(["version"], fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-")));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageVersion);
  assert.equal(result.stderr, "");
});

test("auth-token prints only the configured local token", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.local.token = "9codex_local_cli_test";
  saveConfigAtomic(paths, config);

  const result = run(["auth-token"], home);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "9codex_local_cli_test\n");
  assert.equal(result.stderr, "");
});

test("unknown commands fail without printing credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const result = run(["shell", "whoami"], home);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Commands:/);
  assert.equal(result.stdout, "");
});

test("init requires a terminal when no control-plane URL is supplied", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const result = run(["init"], home);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /交互终端/);
  assert.doesNotMatch(result.stderr, /unconfigured/);
});

test("sync requires init before contacting a relay", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const result = run(["sync"], home);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /请先.*9codex init/);
});

test("skills-sync installs bundled orchestrator without configuration", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const result = run(["skills-sync"], home);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    skills: ["demand-intake", "orchestrator"],
  });
  assert.equal(
    fs.existsSync(path.join(home, ".codex", "skills", "demand-intake", "SKILL.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, ".codex", "skills", "orchestrator", "SKILL.md")),
    true,
  );
  assert.equal(fs.existsSync(path.join(home, ".9codex", "config.json")), false);
});

test("install and codex-restart attempt authoritative self-healing and fail clearly when upstream is unavailable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-cli-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "http://127.0.0.1:1/v1";
  config.upstream.api_key = "secret";
  saveConfigAtomic(paths, config);

  for (const command of ["install", "codex-restart"]) {
    const result = run([command], home);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /fetch failed/i, command);
  }
});
