import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HarnessJsonRpcTransport,
  HarnessProtocolError,
  HarnessRequestTimeoutError,
} from "../lib/harness-jsonrpc-transport.mjs";

const fixture = path.resolve("test/fixtures/harness-jsonrpc-runtime.mjs");

function create(t, mode = "success", options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-harness-"));
  const transport = new HarnessJsonRpcTransport({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    sessionRoot: path.join(root, "sessions"),
    cordisConfig: null,
    provider: "fixture",
    model: "fixture-model",
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    shutdownTimeoutMs: 5_000,
    env: {
      HARNESS_FIXTURE_JSONRPC: "1",
      HARNESS_FIXTURE_MODE: mode,
      ...(options.env || {}),
    },
  });
  t.after(async () => {
    try { await transport.terminate(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return transport;
}

test("initializes, correlates split JSONL responses, creates, resumes, and waits for running+turn/end+idle", async (t) => {
  const transport = create(t);
  const notifications = [];
  const initialized = await transport.initialize();
  assert.equal(initialized.serverInfo.version, "0.1.0-rc.5");

  const first = await transport.run("session-1", "create", {
    onNotification: (event) => notifications.push(event.method),
  });
  const resumed = await transport.run("session-1", "resume");

  assert.equal(first.messageId, "message-1");
  assert.equal(first.finishReason, "completed");
  assert.equal(first.output, "turn-1");
  assert.equal(resumed.messageId, "message-2");
  assert.equal(resumed.output, "turn-2");
  assert.deepEqual(notifications, [
    "session.status",
    "session.event",
    "subagent.started",
    "subagent.finished",
    "session.event",
    "session.status",
  ]);
  assert.match(transport.stderrTail, /fixture initialized/);
});

test("uses the final assistant message instead of duplicating streamed chunks", async (t) => {
  const transport = create(t, "chunk-and-message");
  const result = await transport.run("session-1", "create");

  assert.equal(result.output, "turn-1");
});

test("propagates JSON-RPC failure", async (t) => {
  const transport = create(t, "rpc-failure");
  await assert.rejects(
    transport.run("session-1", "fail"),
    (error) => error.code === -32000 && /fixture failure/.test(error.message),
  );
  assert.equal(transport.closed, false);
  const exit = await transport.shutdown();
  assert.equal(exit.code, 0);
});

test("times out stalled prompt and interrupt terminates the exclusive process", async (t) => {
  const transport = create(t, "timeout", { requestTimeoutMs: 30 });
  await assert.rejects(
    transport.run("session-1", "wait"),
    (error) => error instanceof HarnessRequestTimeoutError,
  );
  const exit = await transport.terminate();
  assert.equal(["SIGTERM", "SIGKILL"].includes(exit.signal), true);
});

test("shutdown requests protocol shutdown and reaps the process", async (t) => {
  const transport = create(t);
  await transport.initialize();
  const exit = await transport.shutdown();
  assert.equal(exit.code, 0);
});

test("redacts the process-only API key from Harness stderr", async (t) => {
  const transport = create(t, "echo-secret-stderr", {
    env: { NINECODEX_HARNESS_API_KEY: "upstream-secret" },
  });
  await transport.initialize();

  assert.equal(transport.stderrTail.includes("upstream-secret"), false);
  assert.match(transport.stderrTail, /\[REDACTED\]/);
});

for (const [mode, message] of [
  ["invalid-json-after-prompt", /invalid JSONL/],
  ["invalid-jsonrpc-after-prompt", /invalid JSON-RPC version/],
  ["malformed-session-status-after-prompt", /session\.status/],
  ["malformed-session-event-after-prompt", /session\.event/],
  ["malformed-subagent-started-after-prompt", /subagent\.started/],
  ["malformed-subagent-finished-after-prompt", /subagent\.finished/],
  ["unknown-notification-after-prompt", /unknown JSON-RPC notification/],
]) {
  test(`${mode} fatally rejects the active run and pending RPC then reaps the process`, async (t) => {
    const transport = create(t, mode);
    await transport.initialize();
    const run = transport.run("session-1", "trigger");
    const pending = transport.request("fixture/pending");

    await assert.rejects(run, (error) => (
      error instanceof HarnessProtocolError && message.test(error.message)
    ));
    await assert.rejects(pending, (error) => (
      error instanceof HarnessProtocolError && message.test(error.message)
    ));
    const exit = await transport.exit.promise;

    assert.equal(transport.closed, true);
    assert.equal(transport.pending.size, 0);
    assert.equal(["SIGTERM", "SIGKILL"].includes(exit.signal), true);
    assert.notEqual(transport.child.exitCode ?? transport.child.signalCode, null);
  });
}

for (const [mode, action, message] of [
  ["invalid-initialize-response", (transport) => transport.initialize(), /invalid serverInfo/],
  ["invalid-prompt-response", (transport) => transport.prompt("session-1", "trigger"), /invalid messageId/],
]) {
  test(`${mode} is fatal and rejects only after reaping the process`, async (t) => {
    const transport = create(t, mode);

    await assert.rejects(action(transport), (error) => (
      error instanceof HarnessProtocolError && message.test(error.message)
    ));
    assert.equal(transport.closed, true);
    assert.notEqual(transport.child.exitCode ?? transport.child.signalCode, null);

    const exit = await transport.exit.promise;
    assert.equal(["SIGTERM", "SIGKILL"].includes(exit.signal), true);
  });
}
