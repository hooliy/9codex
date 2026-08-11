import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexAdapterTimeoutError,
  createCodexAdapter,
  resolveCodexCommand,
} from "../lib/codex-adapter.mjs";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      input: "",
      end: (input = "") => {
        this.stdin.input += input;
      },
    };
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }

  output(...chunks) {
    for (const chunk of chunks) this.stdout.emit("data", chunk);
  }

  close(code = 0, signal = null) {
    this.emit("close", code, signal);
  }
}

function harness() {
  const calls = [];
  let nextId = 0;
  const adapter = createCodexAdapter({
    randomUUID: () => `id-${++nextId}`,
    spawn: (command, args, options) => {
      const process = new FakeProcess();
      calls.push({ command, args, options, process });
      return process;
    },
  });
  return { adapter, calls };
}

test("supports create, read, wait, send, interrupt, resume, and close", async () => {
  const { adapter, calls } = harness();
  const worker = adapter.createWorker("Implement it", { cwd: "/workspace" });

  assert.deepEqual(calls[0].args, [
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    "workspace-write",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "-",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "/workspace");
  assert.equal(calls[0].process.stdin.input, "Implement it");

  calls[0].process.output(
    '{"type":"thread.started","thread_id":"thread-1"}\n',
    '{"type":"item.completed","item":{"text":"done"}}\n',
  );
  calls[0].process.close(0);
  assert.deepEqual(await adapter.waitWorker(worker), {
    operation: "create",
    code: 0,
    signal: null,
    ok: true,
    interrupted: false,
  });
  assert.equal(worker.threadId, "thread-1");
  assert.equal(worker.sessionId, "thread-1");
  assert.equal(adapter.readEvents(worker)[0].type, "thread.started");

  adapter.sendInstruction(worker, "Fix review");
  assert.deepEqual(
    calls[1].args,
    [
      "--ask-for-approval",
      "never",
      "exec",
      "resume",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "thread-1",
      "-",
    ],
  );
  assert.equal(calls[1].process.stdin.input, "Fix review");
  calls[1].process.close(0);
  await adapter.waitWorker(worker);

  adapter.resumeWorker(worker, "Continue");
  assert.equal(calls[2].process.stdin.input, "Continue");
  assert.equal(adapter.interruptWorker(worker), true);
  assert.deepEqual(calls[2].process.kills, ["SIGINT"]);
  assert.equal((await adapter.waitWorker(worker)).interrupted, true);

  const closed = adapter.closeWorker(worker);
  assert.deepEqual(calls[3].args, ["archive", "thread-1"]);
  calls[3].process.close(0);
  assert.equal((await closed).ok, true);
  assert.equal(worker.status, "closed");
});

test("resumes an arbitrary origin thread for delivery", async () => {
  const { adapter, calls } = harness();
  const worker = adapter.resumeThread("origin-thread", "Final report", { cwd: "/workspace" });
  assert.equal(worker.sessionId, "origin-thread");
  assert.equal(calls[0].process.stdin.input, "Final report");
  calls[0].process.close(0);
  assert.equal((await adapter.waitWorker(worker)).ok, true);
});

test("parses fragmented JSONL, preserves events, and records bad lines", async () => {
  const { adapter, calls } = harness();
  const worker = adapter.createWorker("Run");
  calls[0].process.output(
    Buffer.from('{"type":"thread.started","thread_id":"thr'),
    Buffer.from('ead-2"}\nnot-json\n{"type":"message","text":"'),
    Buffer.from("中文\"}"),
  );
  calls[0].process.close(0);
  await adapter.waitWorker(worker);

  const events = adapter.readEvents(worker);
  assert.equal(events[0].thread_id, "thread-2");
  assert.deepEqual(events[1], {
    type: "adapter.jsonl_error",
    operation: "create",
    raw: "not-json",
    message: events[1].message,
  });
  assert.equal(events[2].text, "中文");
  assert.equal(events.at(-1).type, "adapter.process_exit");
});

test("returns non-zero exit codes and stderr as structured evidence", async () => {
  const { adapter, calls } = harness();
  const worker = adapter.createWorker("Fail");
  calls[0].process.stderr.emit("data", "authentication failed");
  calls[0].process.close(17);

  assert.deepEqual(await adapter.waitWorker(worker), {
    operation: "create",
    code: 17,
    signal: null,
    ok: false,
    interrupted: false,
  });
  assert.deepEqual(adapter.readEvents(worker).at(-2), {
    type: "adapter.stderr",
    operation: "create",
    text: "authentication failed",
  });
});

test("wait timeout interrupts only the adapter-owned worker process", async () => {
  const { adapter, calls } = harness();
  const worker = adapter.createWorker("Wait forever");

  await assert.rejects(
    adapter.waitWorker(worker, { timeoutMs: 1 }),
    (error) => error instanceof CodexAdapterTimeoutError
      && error.code === "CODEX_WORKER_TIMEOUT",
  );
  assert.deepEqual(calls[0].process.kills, ["SIGINT"]);
  assert.equal(adapter.interruptWorker(worker), false);
  assert.equal(adapter.interruptWorker({ id: "foreign" }), false);
});

test("rejects invalid instructions and concurrent resumes", () => {
  const { adapter, calls } = harness();
  assert.throws(() => adapter.createWorker(""), /non-empty string/);

  const worker = adapter.createWorker("Start");
  calls[0].process.output(
    '{"type":"thread.started","thread_id":"thread-3"}\n',
  );
  assert.throws(
    () => adapter.resumeWorker(worker, "Overlap"),
    /already running/,
  );
});

test("resolves an explicit Codex command without PATH lookup", () => {
  assert.equal(resolveCodexCommand({ command: "/custom/codex" }), "/custom/codex");
});
