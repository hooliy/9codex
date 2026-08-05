import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { restartCodex } from "../lib/platform.mjs";

test("Windows restart targets only packaged Codex and waits for a new process", async () => {
  const calls = [];
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-ui-session-")), "desktop-session.json");
  let listed = 0;
  const result = await restartCodex({
    platform: "win32",
    debugPort: 53111,
    sessionFile,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
    run: async (file, args) => {
      calls.push({ file, args });
      return { status: 0, stdout: "" };
    },
    listProcesses: async () => {
      listed += 1;
      return listed === 1 ? [{ pid: 101, name: "ChatGPT.exe" }] : [{ pid: 202, name: "ChatGPT.exe" }];
    },
    wait: async () => {},
  });

  assert.deepEqual(calls[0], {
    file: "taskkill.exe",
    args: ["/IM", "ChatGPT.exe", "/T", "/F"],
  });
  assert.deepEqual(calls[1], {
    file: "taskkill.exe",
    args: ["/IM", "codex.exe", "/T", "/F"],
  });
  assert.equal(calls[2].file, "powershell.exe");
  assert.equal(calls[2].args.includes("-WindowStyle"), true);
  assert.match(calls[2].args.at(-1), /ApplicationActivationManager/);
  assert.match(calls[2].args.at(-1), /OpenAI\.Codex_2p2nqsd0c76g0!App/);
  assert.doesNotMatch(calls[2].args.at(-1), /Get-ChildItem/);
  assert.match(calls[2].args.at(-1), /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(calls[2].args.at(-1), /--remote-debugging-port=53111/);
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.previous_pids, [101]);
  assert.deepEqual(result.current_pids, [202]);
  assert.equal(JSON.stringify(calls).includes("cmd.exe"), false);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, "utf8")).debug_port, 53111);
});

test("macOS restart quits and reopens the official app", async () => {
  const calls = [];
  let listed = 0;
  const result = await restartCodex({
    platform: "darwin",
    debugPort: 53112,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
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
    { file: "/usr/bin/osascript", args: ["-e", "tell application \"ChatGPT\" to quit"] },
    {
      file: "/usr/bin/open",
      args: [
        "-a",
        "ChatGPT",
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
    debugPort: 53115,
    gracefulQuitAttempts: 2,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
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
    { file: "/usr/bin/osascript", args: ["-e", "tell application \"ChatGPT\" to quit"] },
    { file: "/usr/bin/pkill", args: ["-x", "ChatGPT"] },
    {
      file: "/usr/bin/open",
      args: [
        "-a",
        "ChatGPT",
        "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=53115",
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
    debugPort: 53113,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
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
    debugPort: 53114,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
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
    { file: "/usr/bin/osascript", args: ["-e", "tell application \"ChatGPT\" to quit"] },
    { file: "/usr/bin/pkill", args: ["-x", "ChatGPT"] },
    {
      file: "/usr/bin/open",
      args: [
        "-a",
        "ChatGPT",
        "--args",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=53114",
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
    openAttempts: 2,
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/usr/bin/osascript") return { status: 1, stderr: "user canceled" };
      if (file === "/usr/bin/open" && ++opened === 1) {
        return { status: 1, stderr: "NSOSStatusErrorDomain Code=-600 procNotFound" };
      }
      return { status: 0, stdout: "" };
    },
    listProcesses: async () => (++listed === 1 ? [{ pid: 31 }] : [{ pid: 32 }]),
    wait: async () => {},
  });

  assert.equal(calls.filter(({ file }) => file === "/usr/bin/open").length, 2);
  assert.equal(result.codex_restarted, true);
  assert.deepEqual(result.current_pids, [32]);
});
