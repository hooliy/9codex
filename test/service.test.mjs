import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installService, restartService, uninstallService } from "../lib/service.mjs";
import { resolvePaths } from "../lib/paths.mjs";

test("Windows install registers a supervised native GUI launcher without a console host", async () => {
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
  const compileCall = calls.find(([, args]) => /OutputType WindowsApplication/.test(args.at(-1)));
  assert.ok(compileCall, "expected native GUI launcher compilation");
  assert.match(compileCall[1].at(-1), /CreateNoWindow = true/);
  assert.match(compileCall[1].at(-1), /WaitForExit/);
  assert.match(compileCall[1].at(-1), /9codex-service-launcher\.exe/);

  const registrationCall = calls.find(([, args]) => /Register-ScheduledTask/.test(args.at(-1)));
  assert.ok(registrationCall, "expected a task registration call");
  const registration = registrationCall[1].at(-1);
  assert.match(registration, /9codex-service-launcher\.exe/);
  assert.match(registration, /9codex\.mjs/);
  assert.match(registration, /--redirect-logs/);
  assert.match(registration, /RestartCount 3/);
  assert.match(registration, /RestartInterval/);
  assert.doesNotMatch(registration, /RepetitionInterval/);
  assert.doesNotMatch(registration, /recoveryTrigger/);
  assert.match(registration, /-Trigger \$logonTrigger/);
  assert.match(registration, /LogonType Interactive/);
  assert.doesNotMatch(registration, /while \(\$true\)/);
  assert.doesNotMatch(registration, /powershell\.exe/);
  assert.doesNotMatch(registration, /wscript\.exe/);
  assert.doesNotMatch(registration, /cmd\.exe/);
  assert.doesNotMatch(registration, /-WindowStyle/);
  assert.equal(registration.includes("service.cmd"), false);
  assert.equal(fs.existsSync(paths.serviceScript), false);
});

test("Windows install removes scoped stale daemons before registering the new runtime", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  const calls = [];

  await installService(paths, {
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\@hooliy\\9codex\\bin\\9codex.mjs",
    run: async (file, args) => {
      calls.push([file, args]);
      return 0;
    },
  });

  const cleanup = calls.find(([file, args]) =>
    file === "powershell.exe"
    && /Get-CimInstance/.test(args.at(-1))
    && /Stop-Process/.test(args.at(-1)),
  );
  assert.ok(cleanup);
  assert.match(cleanup[1].at(-1), /9codex\\\.mjs/);
  assert.match(cleanup[1].at(-1), /daemon/);
  assert.ok(calls.indexOf(cleanup) < calls.findIndex(([, args]) => /Register-ScheduledTask/.test(args.at(-1))));
});

test("macOS install waits for the previous launch agent to unload before registering", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  const calls = [];
  const waits = [];
  let printAttempts = 0;
  let bootstrapped = false;

  const installed = await installService(paths, {
    platform: "darwin",
    nodePath: "/opt/9codex/node",
    cliPath: "/opt/9codex/9codex.mjs",
    wait: async (milliseconds) => { waits.push(milliseconds); },
    run: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === "bootstrap") {
        bootstrapped = true;
        return 0;
      }
      if (args[0] === "print") {
        printAttempts += 1;
        if (!bootstrapped) return printAttempts === 1 ? 0 : 113;
        return printAttempts === 3 ? 113 : 0;
      }
      return 0;
    },
  });

  assert.equal(installed, true);
  assert.equal(printAttempts, 4);
  assert.deepEqual(waits, [250, 250]);
  assert.equal(calls.filter(([, args]) => args[0] === "bootout").length, 1);
  assert.ok(
    calls.findIndex(([, args]) => args[0] === "print")
      < calls.findIndex(([, args]) => args[0] === "bootstrap"),
  );
});

test("macOS install reports the launchctl bootstrap error", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));

  await assert.rejects(
    installService(paths, {
      platform: "darwin",
      nodePath: "/opt/9codex/node",
      cliPath: "/opt/9codex/9codex.mjs",
      run: async (_file, args) => {
        if (args[0] === "print") return 113;
        if (args[0] === "bootstrap") {
          return {
            status: 5,
            stdout: "",
            stderr: "Bootstrap failed: 5: Input/output error",
          };
        }
        return 0;
      },
    }),
    /launchctl bootstrap failed with status 5: Bootstrap failed: 5: Input\/output error/,
  );
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
  const environmentCleanup = calls.find(([file, args]) =>
    file === "powershell.exe"
    && args.at(-1).includes("SetEnvironmentVariable('CODEX_CLI_PATH', $null, 'User')"),
  );
  assert.ok(environmentCleanup);
  assert.match(environmentCleanup[1].at(-1), /codex-wrapper-/);
});

test("macOS uninstall clears only a 9codex-owned Desktop wrapper", async () => {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-service-test-")));
  const calls = [];
  await uninstallService(paths, {
    platform: "darwin",
    run: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === "getenv") {
        return {
          status: 0,
          stdout: `${path.join(paths.stateDir, "codex-wrapper-1234")}\n`,
          stderr: "",
        };
      }
      return 0;
    },
  });

  assert.deepEqual(
    calls.find(([, args]) => args[0] === "unsetenv"),
    ["/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]],
  );
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
