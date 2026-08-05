import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installService, restartService, uninstallService } from "../lib/service.mjs";
import { resolvePaths } from "../lib/paths.mjs";

test("Windows install registers an invisible supervised daemon instead of a visible cmd window", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  const calls = [];

  await installService(paths, {
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\9codex\\bin\\9codex.mjs",
    run: async (file, args) => {
      calls.push([file, args]);
      return 0;
    },
  });

  assert.ok(calls.length >= 1);
  const registrationCall = calls.find(([, args]) => /Register-ScheduledTask/.test(args.at(-1)));
  assert.ok(registrationCall, "expected a task registration call");
  const registration = registrationCall[1].at(-1);
  // schtasks runs node.exe directly - no powershell wrapper, no while loop, no conhost window
  assert.match(registration, /RestartCount 999/);
  assert.match(registration, /RestartInterval/);
  assert.match(registration, /RepetitionInterval/);
  assert.match(registration, /LogonType Interactive/);
  assert.match(registration, /9codex\.mjs/);
  assert.match(registration, /--redirect-logs/);
  assert.doesNotMatch(registration, /while \(\$true\)/);
  assert.doesNotMatch(registration, /powershell\.exe/);
  assert.doesNotMatch(registration, /-WindowStyle/);
  assert.equal(registration.includes("service.cmd"), false);
  assert.equal(fs.existsSync(paths.serviceScript), false);
});

test("macOS install retries launchd bootstrap while the previous agent is still unloading", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  const calls = [];
  const waits = [];
  let bootstrapAttempts = 0;

  const installed = await installService(paths, {
    platform: "darwin",
    nodePath: "/opt/9codex/node",
    cliPath: "/opt/9codex/9codex.mjs",
    wait: async (milliseconds) => { waits.push(milliseconds); },
    run: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === "bootstrap") {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1 ? 5 : 0;
      }
      return 0;
    },
  });

  assert.equal(installed, true);
  assert.equal(bootstrapAttempts, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(calls.filter(([, args]) => args[0] === "bootout").length, 1);
});

test("Windows restart terminates only the recorded 9codex daemon before starting the task", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.daemonPid, "4321\n");
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    return 0;
  };

  await restartService(paths, { platform: "win32", run });

  assert.equal(calls[0][0], "schtasks.exe");
  assert.deepEqual(calls[0][1].slice(0, 2), ["/End", "/TN"]);
  assert.equal(calls[1][0], "powershell.exe");
  assert.match(calls[1][1].at(-1), /recordedPid = 4321/);
  assert.equal(calls[1][1].at(-1).includes("9codex\\.mjs"), true);
  // killStaleDaemonLoops runs between terminate and restart
  assert.equal(calls[2][0], "powershell.exe");
  assert.match(calls[2][1].at(-1), /Get-CimInstance/);
  assert.deepEqual(calls[3], ["schtasks.exe", ["/Run", "/TN", "9codex"]]);
});

test("Windows uninstall also terminates a validated recorded daemon", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.daemonPid, "7654");
  const calls = [];

  await uninstallService(paths, {
    platform: "win32",
    run: async (file, args) => {
      calls.push([file, args]);
      return 0;
    },
  });

  assert.equal(calls.some(([file, args]) => file === "powershell.exe" && args.at(-1).includes("recordedPid = 7654")), true);
});

test("Windows install terminates stale daemon loops and rotates the daemon log before registering", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(paths.daemonLog, "old crash loop noise\n".repeat(5000));
  const calls = [];

  await installService(paths, {
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\9codex\\bin\\9codex.mjs",
    run: async (file, args) => {
      calls.push([file, args]);
      return 0;
    },
  });

  // Before registering the task, stale daemon loops must be killed.
  const killCall = calls.find(([file, args]) =>
    file === "powershell.exe"
    && /Get-CimInstance/.test(args.at(-1))
    && /9codex/.test(args.at(-1))
    && /daemon/.test(args.at(-1))
    && /Stop-Process/.test(args.at(-1)),
  );
  assert.ok(killCall, "expected a stale-loop termination call before task registration");
  // The registration call must come after the kill call.
  assert.ok(calls.indexOf(killCall) < calls.length - 1);
  // The old log noise must be gone (rotated), not appended forever.
  const logContent = fs.readFileSync(paths.daemonLog, "utf8");
  assert.equal(logContent.includes("old crash loop noise"), false);
});
