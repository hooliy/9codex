import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

import { runVerification } from "../lib/verification-runner.mjs";

test("verification runner executes argv without a shell and stores private evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  const artifacts = path.join(root, "artifacts");
  const result = await runVerification([{
    id: "node-self-check",
    command: [process.execPath, "-e", "process.stdout.write('ok')"],
  }], { cwd: root, artifactDir: artifacts });

  assert.equal(result.result, "passed");
  assert.equal(result.evidence[0].exit_code, 0);
  assert.equal(fs.readFileSync(result.evidence[0].output_path, "utf8"), "ok");
  assert.equal(fs.statSync(artifacts).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.evidence[0].output_path).mode & 0o777, 0o600);
});

test("verification runner expands the safe user-id placeholder without a shell", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  const result = await runVerification([{
    id: "uid",
    command: [process.execPath, "-e", "process.exit(process.argv[1] === String(process.getuid()) ? 0 : 1)", "$(id -u)"],
  }], { cwd: root, artifactDir: path.join(root, "artifacts") });

  assert.equal(result.result, "passed");
});

test("verification runner redacts secrets and stops after failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  const result = await runVerification([
    {
      id: "fail",
      command: [process.execPath, "-e", "console.error('token=secret-value');process.exit(4)"],
    },
    {
      id: "must-not-run",
      command: [process.execPath, "-e", "process.exit(0)"],
    },
  ], {
    cwd: root,
    artifactDir: path.join(root, "artifacts"),
    secrets: ["secret-value"],
  });

  assert.equal(result.result, "failed");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].exit_code, 4);
  const output = fs.readFileSync(result.evidence[0].output_path, "utf8");
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /secret-value/);
});

test("verification runner rejects shell strings and records timeout failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  await assert.rejects(
    () => runVerification([{ id: "unsafe", command: "rm -rf /" }], {
      artifactDir: path.join(root, "artifacts"),
    }),
    /command argv/,
  );

  const result = await runVerification([{
    id: "timeout",
    command: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
    timeout_ms: 10,
  }], { cwd: root, artifactDir: path.join(root, "artifacts") });
  assert.equal(result.result, "failed");
  assert.equal(result.evidence[0].timed_out, true);
});

test("verification runner rejects production and irreversible commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  for (const command of [
    ["git", "push", "origin", "main"],
    ["npm", "publish"],
    ["terraform", "apply"],
    ["kubectl", "delete", "namespace", "prod"],
    ["vercel", "--prod"],
    ["rm", "-rf", "build"],
  ]) {
    await assert.rejects(
      () => runVerification([{ id: "unsafe", command }], {
        artifactDir: path.join(root, command[0]),
      }),
      (error) => error.code === "unsafe_command",
    );
  }
});

test("verification runner permits package publication dry-runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-verify-"));
  const result = await runVerification([{
    id: "package-dry-run",
    command: ["npm", "publish", "--dry-run"],
  }], {
    cwd: root,
    artifactDir: path.join(root, "artifacts"),
    spawn: (_file, _args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(result.result, "passed");
});
