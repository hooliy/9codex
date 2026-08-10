import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listCodexProcesses, restartCodex } from "../lib/platform.mjs";

test("Windows process discovery parses tasklist CSV process ids", async () => {
  const processes = await listCodexProcesses("win32", async (_file, args) => ({
    status: 0,
    stdout: args.some((arg) => arg.includes("ChatGPT.exe"))
      ? '"ChatGPT.exe","54372","Console","1","182,000 K"\r\n'
      : '"codex.exe","56240","Console","1","58,000 K"\r\n',
    stderr: "",
  }));

  assert.deepEqual(processes, [
    { pid: 54372, name: "ChatGPT.exe" },
    { pid: 56240, name: "codex.exe" },
  ]);
});

test("Windows restart verifies process state instead of localized taskkill output", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "win32",
    debugPort: 53110,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "taskkill.exe") {
        return { status: 1, stdout: "", stderr: "���� PID 11000 ������" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    listProcesses: async () => {
      listed += 1;
      if (listed === 1) {
        return [
          { pid: 101, name: "ChatGPT.exe" },
          { pid: 102, name: "codex.exe" },
        ];
      }
      if (listed === 2) return [];
      return [{ pid: 202, name: "ChatGPT.exe" }];
    },
    wait: async () => {},
  });

  assert.deepEqual(calls[0], {
    file: "taskkill.exe",
    args: ["/PID", "101", "/PID", "102", "/T", "/F"],
  });
  assert.equal(calls.filter(({ file }) => file === "taskkill.exe").length, 1);
  assert.equal(result.codex_restarted, true);
});

test("Windows restart targets only packaged Codex and waits for a new process", async () => {
  const calls = [];
  const lifecycle = [];
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-ui-session-")), "desktop-session.json");
  let listed = 0;
  const result = await restartCodex({
    platform: "win32",
    debugPort: 53111,
    applyModelPicker: async ({ port }) => ({ connected: true, verified: true, port }),
    sessionFile,
    now: () => new Date("2026-08-06T08:00:00.000Z"),
    run: async (file, args) => {
      calls.push({ file, args });
      lifecycle.push(file);
      return { status: 0, stdout: "" };
    },
    beforeOpen: async () => { lifecycle.push("repair"); },
    listProcesses: async () => {
      listed += 1;
      return listed === 1 ? [{ pid: 101, name: "ChatGPT.exe" }] : [{ pid: 202, name: "ChatGPT.exe" }];
    },
    wait: async () => {},
  });

  assert.deepEqual(calls[0], {
    file: "taskkill.exe",
    args: ["/PID", "101", "/T", "/F"],
  });
  assert.equal(calls[1].file, "powershell.exe");
  assert.equal(calls[1].args.includes("-WindowStyle"), true);
  assert.match(calls[1].args.at(-1), /ApplicationActivationManager/);
  assert.match(calls[1].args.at(-1), /OpenAI\.Codex_2p2nqsd0c76g0!App/);
  assert.doesNotMatch(calls[1].args.at(-1), /Get-ChildItem/);
  assert.match(calls[1].args.at(-1), /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(calls[1].args.at(-1), /--remote-debugging-port=53111/);
  assert.ok(lifecycle.indexOf("repair") > lifecycle.lastIndexOf("taskkill.exe"));
  assert.ok(lifecycle.indexOf("repair") < lifecycle.indexOf("powershell.exe"));
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.previous_pids, [101]);
  assert.deepEqual(result.current_pids, [202]);
  assert.equal(result.debug_port, 53111);
  assert.deepEqual(result.model_picker, { connected: true, verified: true, port: 53111 });
  assert.equal(JSON.stringify(calls).includes("cmd.exe"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, "utf8")), {
    debug_port: 53111,
    process_ids: [202],
    started_at: "2026-08-06T08:00:00.000Z",
    updated_at: "2026-08-06T08:00:00.000Z",
  });
});

test("macOS restart quits and reopens the official app", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53112,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    run: async (file, args) => { calls.push({ file, args }); return { status: 0, stdout: "" }; },
    listProcesses: async () => {
      listed += 1;
      if (listed === 1) return [{ pid: 11 }];
      if (listed === 2) return [];
      return [{ pid: 12 }];
    },
    wait: async () => {},
  });

  assert.deepEqual(calls, [
    {
      file: "/usr/bin/osascript",
      args: ["-e", "tell application id \"com.openai.codex\" to quit"],
    },
    {
      file: "/usr/bin/open",
      args: [
        "-b",
        "com.openai.codex",
        "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=53112",
      ],
    },
  ]);
  assert.equal(result.codex_restarted, true);
});

test("macOS restart targets a process that remains after a successful graceful quit", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53113,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    gracefulQuitAttempts: 2,
    run: async (file, args) => {
      calls.push({ file, args });
      return { status: 0, stdout: "" };
    },
    listProcesses: async () => {
      listed += 1;
      if (listed <= 3) return [{ pid: 21 }];
      return [{ pid: 22 }];
    },
    wait: async () => {},
  });

  assert.deepEqual(calls.slice(0, 3), [
    {
      file: "/usr/bin/osascript",
      args: ["-e", "tell application id \"com.openai.codex\" to quit"],
    },
    { file: "/usr/bin/pkill", args: ["-x", "ChatGPT"] },
    {
      file: "/usr/bin/open",
      args: [
        "-b",
        "com.openai.codex",
        "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=53113",
      ],
    },
  ]);
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.previous_pids, [21]);
  assert.deepEqual(result.current_pids, [22]);
});

test("macOS restart opens Codex directly when it is not already running", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53114,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    run: async (file, args) => {
      calls.push({ file, args });
      return { status: file === "/usr/bin/osascript" ? 1 : 0, stderr: "user canceled" };
    },
    listProcesses: async () => (++listed === 1 ? [] : [{ pid: 13 }]),
    wait: async () => {},
  });

  assert.equal(calls.some(({ file }) => file === "/usr/bin/osascript"), false);
  assert.equal(calls[0].file, "/usr/bin/open");
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.previous_pids, []);
});

test("macOS restart falls back to a targeted kill when graceful quit is canceled", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53115,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/usr/bin/osascript") return { status: 1, stderr: "user canceled" };
      if (file === "/usr/bin/pkill") return { status: 1, stderr: "" };
      return { status: 0, stdout: "" };
    },
    listProcesses: async () => (++listed === 1 ? [{ pid: 14 }] : [{ pid: 15 }]),
    wait: async () => {},
  });

  assert.deepEqual(calls.slice(0, 3), [
    {
      file: "/usr/bin/osascript",
      args: ["-e", "tell application id \"com.openai.codex\" to quit"],
    },
    { file: "/usr/bin/pkill", args: ["-x", "ChatGPT"] },
    {
      file: "/usr/bin/open",
      args: [
        "-b",
        "com.openai.codex",
        "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=53115",
      ],
    },
  ]);
  assert.equal(result.codex_restarted, true);
});

test("macOS restart retries LaunchServices while the terminated app is still unregistering", async () => {
  const calls = [];
  let listed = 0;
  let opened = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53116,
    applyModelPicker: async () => ({ connected: true, verified: true }),
    openAttempts: 5,
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/usr/bin/osascript") return { status: 1, stderr: "user canceled" };
      if (file === "/usr/bin/open" && ++opened < 4) {
        return { status: 1, stderr: "NSOSStatusErrorDomain Code=-600 procNotFound" };
      }
      return { status: 0, stdout: "" };
    },
    listProcesses: async () => {
      listed += 1;
      if (listed <= 3) return [{ pid: 31 }];
      if (listed === 4) return [];
      return [{ pid: 32 }];
    },
    wait: async () => {},
  });

  assert.equal(calls.filter(({ file }) => file === "/usr/bin/open").length, 4);
  assert.ok(
    calls.findIndex(({ file }) => file === "/usr/bin/open")
      > calls.findIndex(({ file }) => file === "/usr/bin/pkill"),
  );
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.current_pids, [32]);
});

test("Codex restart succeeds when the model picker connection is temporarily unavailable", async () => {
  let listed = 0;
  const result = await restartCodex({
    platform: "win32",
    debugPort: 53117,
    applyModelPicker: async () => { throw new TypeError("fetch failed"); },
    run: async () => ({ status: 0, stdout: "", stderr: "" }),
    listProcesses: async () => (++listed === 1 ? [{ pid: 301 }] : [{ pid: 302 }]),
    wait: async () => {},
  });

  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.model_picker, {
    connected: false,
    verified: false,
    error: "fetch failed",
  });
});
