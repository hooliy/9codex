import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntime } from "../lib/codex-runtime.mjs";
import { HarnessRuntime } from "../lib/harness-runtime.mjs";
import {
  RuntimeDriver,
  RuntimeTimeoutError,
  assertRuntimeKind,
  classifyRuntimeFailure,
} from "../lib/runtime-driver.mjs";

function fakeCodexAdapter() {
  const calls = [];
  const workers = new Map();
  const adapter = {
    workers,
    createWorker(instruction, options = {}) {
      const worker = {
        id: "codex-worker",
        sessionId: "codex-session",
        currentRun: { id: "codex-run" },
        events: [{
          type: "thread.started",
          thread_id: "codex-session",
        }],
      };
      workers.set(worker.id, worker);
      calls.push(["createWorker", instruction]);
      options.onEvent?.(worker.events[0], worker);
      return worker;
    },
    async createThread(instruction, options = {}) {
      return this.createWorker(instruction, options);
    },
    sendInstruction(worker, instruction) {
      calls.push(["sendInstruction", worker.id, instruction]);
      return worker;
    },
    readEvents(worker, options = {}) {
      return worker.events.slice(options.after || 0);
    },
    waitWorker: async () => ({
      operation: "create",
      code: 0,
      signal: null,
      ok: true,
      interrupted: false,
    }),
    interruptWorker(worker) {
      calls.push(["interruptWorker", worker.id]);
      return true;
    },
    resumeWorker(worker, instruction) {
      calls.push(["resumeWorker", worker.id, instruction]);
      return worker;
    },
    closeWorker: async (worker) => {
      calls.push(["closeWorker", worker.id]);
      return { ok: true };
    },
    forgetWorker(worker) {
      calls.push(["forgetWorker", worker.id]);
      return true;
    },
    inspectWorker(worker) {
      calls.push(["inspectWorker", worker.id]);
      return { phase: "model_waiting", lastRuntimeEventAt: 1 };
    },
    resumeThread(sessionId, instruction) {
      calls.push(["resumeThread", sessionId, instruction]);
      return { id: "resumed", sessionId, events: [], currentRun: { id: "resume-run" } };
    },
  };
  return { adapter, calls };
}

class FakeHarnessTransport {
  constructor(behaviors = []) {
    this.behaviors = [...behaviors];
    this.calls = [];
    this.closed = false;
    this.stderrTail = "";
    this.pending = null;
    this.terminated = 0;
    this.shutdowns = 0;
  }

  async run(sessionId, instruction, { onNotification } = {}) {
    if (this.closed) throw Object.assign(new Error("terminated"), { code: "TERMINATED" });
    this.calls.push({ sessionId, instruction });
    const behavior = this.behaviors.shift() || "completed";
    if (behavior instanceof Error) throw behavior;
    if (behavior === "wait") {
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
      });
    }
    onNotification?.({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        sessionId,
        event: { type: "assistant/chunk", data: { chunk: { type: "text-delta", text: instruction } } },
      },
    });
    return {
      messageId: `message-${this.calls.length}`,
      finishReason: behavior,
      output: instruction,
    };
  }

  async terminate() {
    this.terminated += 1;
    this.closed = true;
    this.pending?.reject(Object.assign(new Error("terminated"), { code: "TERMINATED" }));
    this.pending = null;
    return { code: null, signal: "SIGTERM" };
  }

  async shutdown() {
    this.shutdowns += 1;
    this.closed = true;
    return { code: 0, signal: null };
  }
}

test("runtime_kind only accepts codex and deepseek-harness", () => {
  assert.equal(assertRuntimeKind("codex"), "codex");
  assert.equal(assertRuntimeKind("deepseek-harness"), "deepseek-harness");
  assert.throws(() => assertRuntimeKind("harness"), /runtime_kind/);
  assert.throws(() => assertRuntimeKind(), /runtime_kind/);
});

test("runtime failure classification separates retryable upstream faults from hard configuration faults", () => {
  assert.deepEqual(classifyRuntimeFailure({
    code: "HARNESS_REQUEST_TIMEOUT",
    message: "Harness request session/prompt timed out",
  }), {
    category: "upstream_request_timeout",
    recoverable: true,
    code: "HARNESS_REQUEST_TIMEOUT",
    status: null,
  });
  assert.equal(classifyRuntimeFailure({ message: "HTTP 429 retry later" }).category, "upstream_rate_limited");
  assert.equal(
    classifyRuntimeFailure({ message: "HTTP 429 retry-after: 5" }).retryAfterMs,
    5_000,
  );
  assert.equal(classifyRuntimeFailure({ message: "HTTP 503 unavailable" }).recoverable, true);
  assert.equal(classifyRuntimeFailure({ message: "401 invalid API key" }).recoverable, true);
  assert.equal(classifyRuntimeFailure({ message: "upstream_quota_exhausted" }).category, "upstream_quota_exhausted");
  assert.equal(classifyRuntimeFailure({ message: "model not found" }).category, "model_unavailable");
  assert.equal(classifyRuntimeFailure({ message: "context length exceeded" }).category, "context_limit");
});

test("CodexRuntime reuses CodexAdapter and exposes unified events", async () => {
  const { adapter, calls } = fakeCodexAdapter();
  const runtime = new CodexRuntime({ adapter });
  const observed = [];
  const worker = runtime.createWorker("implement", {
    onEvent: (event) => observed.push(event),
  });

  assert.equal(runtime.runtime_kind, "codex");
  assert.equal(worker.runtime_kind, "codex");
  assert.deepEqual(calls[0], ["createWorker", "implement"]);
  assert.deepEqual(observed[0], {
    sequence: 1,
    type: "session.created",
    runtime_kind: "codex",
    worker_id: "codex-worker",
    session_id: "codex-session",
    run_id: "codex-run",
    data: {
      type: "thread.started",
      thread_id: "codex-session",
    },
  });
  assert.deepEqual(runtime.readEvents(worker), observed);
  assert.equal((await runtime.waitWorker(worker)).ok, true);

  runtime.sendInstruction(worker, "review");
  runtime.resumeWorker(worker, "continue");
  assert.equal(runtime.interruptWorker(worker), true);
  assert.equal((await runtime.closeWorker(worker)).ok, true);
  assert.equal(runtime.forgetWorker(worker), true);
  assert.deepEqual(runtime.inspectWorker(worker), {
    phase: "model_waiting",
    lastRuntimeEventAt: 1,
    failure: null,
  });
  assert.deepEqual(calls.slice(1), [
    ["sendInstruction", "codex-worker", "review"],
    ["resumeWorker", "codex-worker", "continue"],
    ["interruptWorker", "codex-worker"],
    ["closeWorker", "codex-worker"],
    ["forgetWorker", "codex-worker"],
    ["inspectWorker", "codex-worker"],
  ]);
});

test("CodexRuntime treats repeated upstream retry output as a model-call fault", () => {
  const { adapter } = fakeCodexAdapter();
  adapter.inspectWorker = () => ({
    phase: "model_waiting",
    lastRuntimeEventAt: 1,
    lastEvent: { type: "message", text: "retry later" },
    retrySignalCount: 3,
  });
  const runtime = new CodexRuntime({ adapter });

  assert.equal(runtime.inspectWorker("codex-worker").failure.category, "upstream_rate_limited");
});

test("HarnessRuntime provides create, resume, unified events, and graceful close", async () => {
  const transports = [];
  const runtime = new HarnessRuntime({
    randomUUID: (() => {
      let id = 0;
      return () => `harness-${++id}`;
    })(),
    transport() {
      const transport = new FakeHarnessTransport();
      transports.push(transport);
      return transport;
    },
  });

  const worker = runtime.createWorker("implement", { cwd: "/workspace" });
  assert.equal((await runtime.waitWorker(worker)).ok, true);
  assert.equal(worker.sessionId, "harness-1");
  assert.deepEqual(
    runtime.readEvents(worker).map((event) => event.type),
    ["session.created", "run.started", "run.output", "run.output", "run.completed"],
  );
  runtime.sendInstruction(worker, "continue");
  assert.equal((await runtime.waitWorker(worker)).ok, true);
  assert.deepEqual(transports[0].calls, [
    { sessionId: "harness-1", instruction: "implement" },
    { sessionId: "harness-1", instruction: "continue" },
  ]);

  assert.equal((await runtime.closeWorker(worker)).ok, true);
  assert.equal(transports[0].shutdowns, 1);
  assert.equal(worker.status, "closed");
  assert.equal(runtime.readEvents(worker).at(-1).type, "session.closed");
});

test("HarnessRuntime propagates transport errors and failed turn reasons", async () => {
  const failure = Object.assign(new Error("bridge unavailable"), { code: "BRIDGE_DOWN" });
  const runtime = new HarnessRuntime({
    transport: () => new FakeHarnessTransport([failure]),
  });
  const worker = runtime.createWorker("implement");

  await assert.rejects(runtime.waitWorker(worker), (error) => error === failure);
  assert.equal(runtime.readEvents(worker).at(-1).type, "run.failed");
  assert.equal(runtime.readEvents(worker).at(-1).data.code, "BRIDGE_DOWN");
  const failedRuntime = new HarnessRuntime({
    transport: () => new FakeHarnessTransport(["failed"]),
  });
  const failedWorker = failedRuntime.createWorker("implement");

  assert.deepEqual(await failedRuntime.waitWorker(failedWorker), {
    operation: "create",
    code: 1,
    signal: null,
    ok: false,
    interrupted: false,
    finishReason: "failed",
    messageId: "message-1",
  });
  assert.equal(failedWorker.status, "failed");
  assert.equal(failedRuntime.readEvents(failedWorker).at(-1).type, "run.failed");
});

test("HarnessRuntime timeout and interrupt terminate the Worker-exclusive process", async () => {
  const timeoutTransport = new FakeHarnessTransport(["wait"]);
  const runtime = new HarnessRuntime({
    transport: () => timeoutTransport,
  });

  assert.throws(() => runtime.createWorker(""), /instruction/);
  assert.throws(() => runtime.resumeThread("", "continue"), /session_id/);
  const worker = runtime.createWorker("wait");
  await assert.rejects(
    runtime.waitWorker(worker, { timeoutMs: 1 }),
    (error) => error instanceof RuntimeTimeoutError
      && error.code === "RUNTIME_TIMEOUT",
  );
  await worker.currentRun.done;
  assert.equal(timeoutTransport.terminated, 1);
  assert.equal(runtime.readEvents(worker).at(-1).type, "run.cancelled");

  const interruptTransport = new FakeHarnessTransport(["wait"]);
  const interruptRuntime = new HarnessRuntime({
    transport: () => interruptTransport,
  });
  const interrupted = interruptRuntime.createWorker("wait");
  assert.equal(interruptRuntime.interruptWorker(interrupted), true);
  assert.equal((await interruptRuntime.waitWorker(interrupted)).interrupted, true);
  assert.equal(interruptTransport.terminated, 1);
  assert.equal(interruptRuntime.readEvents(interrupted).at(-1).type, "run.cancelled");
});

test("HarnessRuntime creates one transport per Worker and resumes an existing session", async () => {
  const sessions = [];
  const runtime = new HarnessRuntime({
    transport: ({ sessionId }) => {
      sessions.push(sessionId);
      return new FakeHarnessTransport();
    },
  });
  const first = runtime.createWorker("one");
  const resumed = runtime.resumeThread("existing-session", "two");
  await Promise.all([runtime.waitWorker(first), runtime.waitWorker(resumed)]);
  assert.deepEqual(sessions, [first.sessionId, "existing-session"]);
  assert.notEqual(first.id, resumed.id);
});

test("HarnessRuntime passes the process-only API key and Worker env to Transport", async () => {
  let transportOptions;
  const runtime = new HarnessRuntime({
    env: { NINECODEX_HARNESS_API_KEY: "upstream-secret", BASE_ONLY: "base" },
    transport: (options) => {
      transportOptions = options;
      return new FakeHarnessTransport();
    },
  });
  const worker = runtime.createWorker("one", {
    env: { PATH: "/worker/bin", WORKER_ONLY: "worker" },
  });
  await runtime.waitWorker(worker);

  assert.deepEqual(transportOptions.env, {
    NINECODEX_HARNESS_API_KEY: "upstream-secret",
    BASE_ONLY: "base",
    PATH: "/worker/bin",
    WORKER_ONLY: "worker",
  });
});

test("HarnessRuntime maps the trusted sandbox mode into the Harness process env", async () => {
  const transports = [];
  const runtime = new HarnessRuntime({
    sandbox: "read-only",
    transport: (options) => {
      transports.push(options);
      return new FakeHarnessTransport();
    },
  });
  const planner = runtime.createWorker("plan", {
    env: { NINECODEX_HARNESS_SANDBOX_MODE: "danger-full-access" },
  });
  const developer = runtime.createWorker("develop", {
    sandbox: "workspace-write",
    env: { NINECODEX_HARNESS_SANDBOX_MODE: "danger-full-access" },
  });
  await Promise.all([runtime.waitWorker(planner), runtime.waitWorker(developer)]);

  assert.equal(transports[0].env.NINECODEX_HARNESS_SANDBOX_MODE, "read-only");
  assert.equal(transports[1].env.NINECODEX_HARNESS_SANDBOX_MODE, "workspace-write");
});

test("HarnessRuntime rejects an invalid sandbox mode before spawning Transport", () => {
  let spawned = false;
  const runtime = new HarnessRuntime({
    transport: () => {
      spawned = true;
      return new FakeHarnessTransport();
    },
  });

  assert.throws(
    () => runtime.createWorker("unsafe", { sandbox: "unrestricted" }),
    /sandbox must be read-only, workspace-write, or danger-full-access/,
  );
  assert.equal(spawned, false);
});

test("RuntimeDriver binds one matching runtime without a registry", () => {
  const runtime = {
    runtime_kind: "codex",
    createWorker: (...args) => args,
    createThread: (...args) => args,
    sendInstruction: (...args) => args,
    readEvents: (...args) => args,
    waitWorker: (...args) => args,
    interruptWorker: (...args) => args,
    resumeWorker: (...args) => args,
    closeWorker: (...args) => args,
    resumeThread: (...args) => args,
    forgetWorker: (...args) => args,
    inspectWorker: (...args) => args,
  };
  const driver = new RuntimeDriver({ runtime_kind: "codex", runtime });

  assert.equal(driver.runtime_kind, "codex");
  assert.deepEqual(driver.createWorker("task"), ["task"]);
  assert.throws(
    () => new RuntimeDriver({ runtime_kind: "deepseek-harness", runtime }),
    /does not match/,
  );
});
