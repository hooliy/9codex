import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { prepareHarnessNodePtyAdapter } from "../lib/harness-node-pty-adapter.mjs";

test("macOS Harness adapter redirects node-pty without modifying Harness node_modules", {
  skip: process.platform !== "darwin",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-node-pty-"));
  const runtime = path.join(root, "runtime");
  const source = path.join(runtime, "node_modules", "node-pty");
  const helper = path.join(source, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(path.join(source, "lib"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "cordis.yml"), "[]\n");
  fs.writeFileSync(path.join(runtime, "package.json"), "{\"private\":true}\n");
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "node-pty", version: "1.1.0", main: "lib/index.js" }),
  );
  fs.writeFileSync(path.join(source, "lib", "index.js"), "module.exports = { marker: 'mirror' };\n");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  const stateDir = path.join(root, "state");
  const env = prepareHarnessNodePtyAdapter({
    cordisConfig: path.join(runtime, "cordis.yml"),
    stateDir,
    env: { NODE_OPTIONS: "--no-warnings" },
  });
  const mirroredHelper = path.join(
    stateDir,
    "harness-adapters",
    `node-pty-1.1.0-${process.arch}`,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );

  assert.equal(fs.statSync(helper).mode & 0o111, 0);
  assert.notEqual(fs.statSync(mirroredHelper).mode & 0o111, 0);
  assert.match(env.NODE_OPTIONS, /--no-warnings --import=file:/);

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "console.log((await import('node-pty')).default.marker)"],
    {
      cwd: runtime,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "mirror");
});
