import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  reserveLoopbackPort,
  waitForModelPickerPolicy,
} from "./model-picker.mjs";

function runDefault(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({ status: -1, stdout: "", stderr: error.message }));
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

export async function listCodexProcesses(platform = process.platform, run = runDefault) {
  if (platform === "win32") {
    const names = ["ChatGPT.exe", "codex.exe"];
    const processes = [];
    for (const name of names) {
      const result = await run("tasklist.exe", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"]);
      if (result.status !== 0) continue;
      const pattern = new RegExp(`^"${name}","(\\d+)"`, "i");
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(pattern);
        if (match) processes.push({ pid: Number(match[1]), name });
      }
    }
    return processes;
  }
  const result = await run("/bin/ps", ["-axo", "pid=,command="]);
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/);
    return match ? [{ pid: Number(match[1]), name: "ChatGPT" }] : [];
  });
}

function waitDefault(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function saveDesktopSession(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function restartCodex(options = {}) {
  const platform = options.platform || process.platform;
  if (!['win32', 'darwin'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const run = options.run || runDefault;
  const listProcesses = options.listProcesses || (() => listCodexProcesses(platform, run));
  const wait = options.wait || waitDefault;
  const debugPort = options.debugPort ?? await reserveLoopbackPort();
  const applyModelPicker = options.applyModelPicker || waitForModelPickerPolicy;
  const before = await listProcesses();
  const beforeIds = new Set(before.map((item) => item.pid));
  let openFailure = null;
  let startedAt;

  if (platform === "win32") {
    if (before.length > 0) {
      await run("taskkill.exe", [
        ...before.flatMap(({ pid }) => ["/PID", String(pid)]),
        "/T",
        "/F",
      ]);
      let remaining = before;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await wait(250);
        const current = await listProcesses();
        remaining = current.filter(({ pid }) => beforeIds.has(pid));
        if (remaining.length === 0) break;
      }
      if (remaining.length > 0) {
        throw new Error(`Unable to stop Codex processes: ${remaining.map(({ pid }) => pid).join(", ")}`);
      }
    }
    startedAt = (options.now?.() || new Date()).toISOString();
    await options.beforeOpen?.();
    const activationSource = `using System;
using System.Runtime.InteropServices;
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
  int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);
  int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
}
public static class NineCodexAppActivator {
  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
    Marshal.ThrowExceptionForHR(result);
    return processId;
  }
}`;
    const launchArguments =
      `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`;
    const launchScript = [
      `$source = '${activationSource.replaceAll("'", "''")}'`,
      "Add-Type -TypeDefinition $source",
      `[NineCodexAppActivator]::Activate('OpenAI.Codex_2p2nqsd0c76g0!App', '${launchArguments}') | Out-Null`,
    ].join("; ");
    const opened = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      launchScript,
    ]);
    if (opened.status !== 0) openFailure = opened.stderr || opened.stdout || `exit ${opened.status}`;
  } else {
    if (before.length > 0) {
      const stopped = await run("/usr/bin/osascript", [
        "-e",
        "tell application id \"com.openai.codex\" to quit",
      ]);
      let gracefulExit = stopped.status === 0;
      if (gracefulExit) {
        const attempts = options.gracefulQuitAttempts || 8;
        gracefulExit = false;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await wait(250);
          const remaining = await listProcesses();
          if (!remaining.some((item) => beforeIds.has(item.pid))) {
            gracefulExit = true;
            break;
          }
        }
      }
      if (!gracefulExit) {
        const forced = await run("/usr/bin/pkill", ["-x", "ChatGPT"]);
        if (![0, 1].includes(forced.status)) {
          throw new Error(`Unable to stop Codex: ${forced.stderr || forced.stdout || stopped.stderr || stopped.stdout}`);
        }
        let remaining = before;
        const attempts = options.forcedQuitAttempts || 20;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await wait(250);
          const current = await listProcesses();
          remaining = current.filter(({ pid }) => beforeIds.has(pid));
          if (remaining.length === 0) break;
        }
        if (remaining.length > 0) {
          const killed = await run("/bin/kill", [
            "-9",
            ...remaining.map(({ pid }) => String(pid)),
          ]);
          if (killed.status !== 0) {
            throw new Error(`Unable to stop Codex processes: ${remaining.map(({ pid }) => pid).join(", ")}`);
          }
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await wait(250);
            const current = await listProcesses();
            remaining = current.filter(({ pid }) => beforeIds.has(pid));
            if (remaining.length === 0) break;
          }
          if (remaining.length > 0) {
            throw new Error(`Unable to stop Codex processes: ${remaining.map(({ pid }) => pid).join(", ")}`);
          }
        }
      }
    }
    startedAt = (options.now?.() || new Date()).toISOString();
    await options.beforeOpen?.();
    const openArgs = [
      "-n",
      "-b",
      "com.openai.codex",
      "--args",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
    ];
    const attempts = options.openAttempts || 8;
    let opened;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      opened = await run("/usr/bin/open", openArgs);
      if (opened.status === 0) break;
      const output = `${opened.stderr || ""} ${opened.stdout || ""}`;
      if (!/Code=-600|procNotFound/i.test(output) || attempt === attempts - 1) break;
      await wait(Math.min(500 * (attempt + 1), 2000));
    }
    if (opened.status !== 0) throw new Error(`Unable to open Codex: ${opened.stderr || opened.stdout}`);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await listProcesses();
    const fresh = current.filter((item) => !beforeIds.has(item.pid));
    if (fresh.length > 0) {
      let modelPicker;
      try {
        modelPicker = await applyModelPicker({ port: debugPort, wait });
      } catch (error) {
        modelPicker = {
          connected: false,
          verified: false,
          error: error?.message || String(error),
        };
      }
      const result = {
        codex_restarted: true,
        previous_pids: [...beforeIds],
        current_pids: fresh.map((item) => item.pid),
        debug_port: debugPort,
        model_picker: modelPicker,
      };
      saveDesktopSession(options.sessionFile, {
        debug_port: debugPort,
        process_ids: result.current_pids,
        started_at: startedAt,
        updated_at: (options.now?.() || new Date()).toISOString(),
      });
      return result;
    }
    await wait(500);
  }
  if (openFailure) throw new Error(`Unable to open Codex: ${openFailure}`);
  throw new Error("Codex did not restart within 20 seconds");
}
