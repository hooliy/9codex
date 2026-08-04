import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dispatchRemoteCommand,
  maintainCodexModelPicker,
  parseSseCommands,
} from "../lib/daemon.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const now = new Date("2026-08-01T08:05:00Z");

function remoteCommand(type, sequence = 1, payload = {}) {
  return {
    command_id: `cmd_${sequence}`,
    sequence,
    type,
    issued_at: "2026-08-01T08:00:00Z",
    expires_at: "2026-08-01T08:10:00Z",
    payload,
  };
}

test("parses command events from fragmented SSE input", () => {
  const chunks = [
    "event: command\nid: cmd_1\ndata: {\"command_id\":\"cmd_1\",\"sequence\":1,",
    "\"type\":\"codex.restart\",\"issued_at\":\"2026-08-01T08:00:00Z\",",
    "\"expires_at\":\"2026-08-01T08:10:00Z\",\"payload\":{}}\n\n",
  ];

  assert.deepEqual(parseSseCommands(chunks), [remoteCommand("codex.restart")]);
});

test("acknowledges lifecycle and automatically restarts Codex", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const statuses = [];
  let codexRestarted = 0;
  const config = {
    installation: { installation_id: "ins_test" },
    codex: { restart_policy: "automatic" },
  };

  const result = await dispatchRemoteCommand(remoteCommand("codex.restart"), {
    paths,
    config,
    now: () => now,
    ack: async (payload) => { statuses.push(payload.status); },
    restartCodex: async () => { codexRestarted += 1; return { codex_restarted: true }; },
  });

  assert.deepEqual(statuses, ["received", "running", "succeeded"]);
  assert.equal(codexRestarted, 1);
  assert.equal(result.codex_restarted, true);
});

test("refreshes configuration, rewrites catalog, acknowledges, then restarts local service", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-daemon-test-"));
  const paths = resolvePaths(home);
  const order = [];
  const config = {
    installation: { installation_id: "ins_test" },
    codex: { restart_policy: "automatic" },
  };
  await dispatchRemoteCommand(remoteCommand("config.refresh"), {
    paths,
    config,
    now: () => now,
    ack: async (payload) => { order.push(`ack:${payload.status}`); },
    syncConfig: async () => { order.push("sync"); return { changed: true, config: { ...config, models: {} } }; },
    writeCatalog: async () => { order.push("catalog"); },
    injectCodex: async () => { order.push("inject"); },
    restartService: async () => { order.push("restart-service"); },
  });

  assert.deepEqual(order, [
    "ack:received",
    "ack:running",
    "sync",
    "catalog",
    "inject",
    "ack:succeeded",
    "restart-service",
  ]);
});

test("desktop watcher restores the 9codex renderer integration after a normal Codex launch", async () => {
  const state = { port: null, failures: 2, restarting: false };
  let restarts = 0;
  const result = await maintainCodexModelPicker(state, {
    listProcesses: async () => [{ pid: 77, name: "ChatGPT.exe" }],
    restartCodex: async () => {
      restarts += 1;
      return { codex_restarted: true, debug_port: 53113 };
    },
  });

  assert.equal(restarts, 1);
  assert.equal(result, "restarted");
  assert.deepEqual(state, { port: 53113, failures: 0, restarting: false });
});

test("desktop watcher immediately replaces a normal launch whose processes differ from the saved debug session", async () => {
  const state = { port: null, failures: 0, restarting: false };
  let restarts = 0;
  const result = await maintainCodexModelPicker(state, {
    listProcesses: async () => [{ pid: 82, name: "ChatGPT.exe" }],
    loadSession: () => ({ debug_port: 53116, process_ids: [81] }),
    enableModelPicker: async () => { throw new Error("debug endpoint is not available"); },
    restartCodex: async () => {
      restarts += 1;
      return { codex_restarted: true, debug_port: 53117 };
    },
  });

  assert.equal(restarts, 1);
  assert.equal(result, "restarted");
  assert.deepEqual(state, { port: 53117, failures: 0, restarting: false });
});

test("desktop watcher waits when the saved debug session still owns a starting Codex process", async () => {
  const state = { port: null, failures: 0, restarting: false };
  let restarts = 0;
  const result = await maintainCodexModelPicker(state, {
    listProcesses: async () => [{ pid: 83, name: "ChatGPT.exe" }],
    loadSession: () => ({ debug_port: 53118, process_ids: [83] }),
    enableModelPicker: async () => { throw new Error("renderer is still starting"); },
    restartCodex: async () => { restarts += 1; },
  });

  assert.equal(restarts, 0);
  assert.equal(result, "waiting");
  assert.equal(state.failures, 1);
});

test("desktop watcher keeps a healthy in-memory integration without restarting Codex", async () => {
  const state = { port: 53114, failures: 0, restarting: false };
  let restarts = 0;
  const result = await maintainCodexModelPicker(state, {
    listProcesses: async () => [{ pid: 78, name: "ChatGPT.exe" }],
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
    restartCodex: async () => { restarts += 1; },
  });

  assert.equal(result, "healthy");
  assert.equal(restarts, 0);
  assert.equal(state.failures, 0);
});

test("desktop watcher adopts a session created by the CLI instead of restarting it", async () => {
  const state = { port: null, failures: 0, restarting: false };
  let restarts = 0;
  const result = await maintainCodexModelPicker(state, {
    listProcesses: async () => [{ pid: 79, name: "ChatGPT.exe" }],
    loadSession: () => ({ debug_port: 53115 }),
    enableModelPicker: async ({ port }) => ({ connected: true, port }),
    restartCodex: async () => { restarts += 1; },
  });

  assert.equal(result, "healthy");
  assert.equal(state.port, 53115);
  assert.equal(restarts, 0);
});
