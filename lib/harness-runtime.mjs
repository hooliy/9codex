import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createHarnessJsonRpcTransport } from "./harness-jsonrpc-transport.mjs";
import { prepareHarnessNodePtyAdapter } from "./harness-node-pty-adapter.mjs";
import {
  RuntimeTimeoutError,
  assertInstruction,
  assertRuntimeOptions,
  assertSessionId,
  normalizeRuntimeEvent,
} from "./runtime-driver.mjs";

const HARNESS_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function harnessSandboxMode(value) {
  if (value === undefined) return null;
  if (!HARNESS_SANDBOX_MODES.has(value)) {
    throw new TypeError("sandbox must be read-only, workspace-write, or danger-full-access");
  }
  return value;
}

function result(operation, extra = {}) {
  return {
    operation,
    code: extra.code ?? (extra.ok === false ? 1 : 0),
    signal: extra.signal ?? null,
    ok: extra.ok ?? true,
    interrupted: Boolean(extra.interrupted),
    finishReason: extra.finishReason ?? null,
    messageId: extra.messageId ?? null,
  };
}

export class HarnessRuntime {
  constructor(options = {}) {
    assertRuntimeOptions(options);
    this.runtime_kind = "deepseek-harness";
    this.options = { ...options };
    this.randomUUID = options.randomUUID || randomUUID;
    this.transportInjection = options.transport;
    this.workers = new Map();
  }

  createWorker(instruction, options = {}) {
    assertInstruction(instruction);
    assertRuntimeOptions(options);
    const worker = this.#newWorker(options);
    this.workers.set(worker.id, worker);
    this.#emit(worker, null, { type: "session.created" });
    this.#start(worker, "create", instruction);
    return worker;
  }

  async createThread(instruction, options = {}) {
    const worker = this.createWorker(instruction, options);
    const completed = await this.waitWorker(worker, {
      timeoutMs: options.threadStartTimeoutMs ?? this.options.requestTimeoutMs ?? 300_000,
    });
    if (!completed.ok) throw new Error(`Harness session creation failed: ${completed.finishReason || completed.code}`);
    return worker;
  }

  sendInstruction(workerOrId, instruction) {
    return this.resumeWorker(workerOrId, instruction);
  }

  readEvents(workerOrId, options = {}) {
    assertRuntimeOptions(options);
    const worker = this.#worker(workerOrId);
    const after = Number.isInteger(options.after) && options.after >= 0 ? options.after : 0;
    return worker.events.slice(after);
  }

  async waitWorker(workerOrId, options = {}) {
    assertRuntimeOptions(options);
    const worker = this.#worker(workerOrId);
    const run = worker.currentRun;
    if (!run) {
      if (worker.lastResult) return worker.lastResult;
      throw new Error(`Worker ${worker.id} has no run to wait for`);
    }
    if (options.timeoutMs === undefined) return run.done;
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }
    let timer;
    try {
      return await Promise.race([
        run.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.interruptWorker(worker);
            reject(new RuntimeTimeoutError(worker.id, options.timeoutMs));
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  interruptWorker(workerOrId) {
    const worker = typeof workerOrId === "string" ? this.workers.get(workerOrId) : workerOrId;
    if (!worker || this.workers.get(worker.id) !== worker) return false;
    const run = worker.currentRun;
    if (!run || run.settled || run.interrupted) return false;
    run.interrupted = true;
    worker.status = "interrupting";
    void worker.transport.terminate();
    return true;
  }

  resumeWorker(workerOrId, instruction) {
    assertInstruction(instruction);
    const worker = this.#worker(workerOrId);
    if (worker.status === "closed") throw new Error(`Worker ${worker.id} is closed`);
    if (worker.currentRun && !worker.currentRun.settled) {
      throw new Error(`Worker ${worker.id} is already running`);
    }
    if (worker.transport.closed) {
      throw new Error(`Worker ${worker.id} Harness process is not running`);
    }
    this.#start(worker, "resume", instruction);
    return worker;
  }

  async closeWorker(workerOrId) {
    const worker = this.#worker(workerOrId);
    if (worker.status === "closed") return worker.lastResult;
    if (worker.currentRun && !worker.currentRun.settled) {
      this.interruptWorker(worker);
      await worker.currentRun.done;
    } else {
      await worker.transport.shutdown();
    }
    worker.status = "closed";
    const closed = result("close", { ok: true });
    worker.lastResult = closed;
    this.#emit(worker, null, {
      type: "session.closed",
      processTerminated: true,
      runtimeSessionClosed: false,
    });
    return closed;
  }

  resumeThread(sessionId, instruction, options = {}) {
    assertSessionId(sessionId);
    assertInstruction(instruction);
    assertRuntimeOptions(options);
    const worker = this.#newWorker(options, sessionId);
    this.workers.set(worker.id, worker);
    this.#emit(worker, null, { type: "session.created", resumed: true });
    this.#start(worker, "resume", instruction);
    return worker;
  }

  forgetWorker(workerOrId) {
    const worker = typeof workerOrId === "string" ? this.workers.get(workerOrId) : workerOrId;
    if (!worker || worker.currentRun && !worker.currentRun.settled) return false;
    if (!worker.transport.closed) void worker.transport.shutdown();
    return this.workers.delete(worker.id);
  }

  #newWorker(options, sessionId = this.randomUUID()) {
    const transport = this.#transport(options, sessionId);
    return {
      id: this.randomUUID(),
      runtime_kind: this.runtime_kind,
      sessionId,
      status: "creating",
      events: [],
      runs: [],
      currentRun: null,
      lastResult: null,
      lastEventAt: Date.now(),
      transport,
      onEvent: options.onEvent,
    };
  }

  #transport(options, sessionId) {
    const sandbox = harnessSandboxMode(options.sandbox ?? this.options.sandbox);
    const transportOptions = {
      ...options,
      sessionId,
      env: {
        ...(options.env || {}),
        ...(this.options.env || {}),
        ...(sandbox ? { NINECODEX_HARNESS_SANDBOX_MODE: sandbox } : {}),
      },
    };
    const injection = options.transport ?? this.transportInjection;
    if (typeof injection === "function") return injection(transportOptions);
    if (injection) return injection;
    const cwd = options.cwd || this.options.cwd || process.cwd();
    const cordisConfig = options.cordisConfig
      ?? options.cordis_config
      ?? this.options.cordisConfig
      ?? this.options.cordis_config
      ?? null;
    if (!cordisConfig || !fs.existsSync(cordisConfig) || !fs.statSync(cordisConfig).isFile()) {
      throw new Error("Harness cordis_config must be an existing file");
    }
    const root = options.sessionRoot
      || this.options.sessionRoot
      || path.join(this.options.stateDir || cwd, ".9codex-harness-sessions", sessionId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const command = options.command || this.options.command || "dsh-jsonrpc-agent";
    const env = prepareHarnessNodePtyAdapter({
      cordisConfig,
      stateDir: this.options.stateDir || path.join(cwd, ".9codex"),
      env: transportOptions.env,
    });
    return createHarnessJsonRpcTransport({
      command,
      args: options.args || this.options.args || [],
      cordisConfig,
      cwd,
      sessionRoot: root,
      env,
      provider: options.provider || this.options.provider,
      model: options.model || this.options.model,
      maxTokens: options.maxTokens ?? options.max_tokens
        ?? this.options.maxTokens ?? this.options.max_tokens ?? null,
      requestTimeoutMs: options.requestTimeoutMs ?? options.request_timeout_ms
        ?? this.options.requestTimeoutMs ?? this.options.request_timeout_ms ?? 300_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? this.options.shutdownTimeoutMs,
    });
  }

  #worker(workerOrId) {
    const worker = typeof workerOrId === "string" ? this.workers.get(workerOrId) : workerOrId;
    if (!worker || this.workers.get(worker.id) !== worker) throw new Error("Unknown Harness worker");
    return worker;
  }

  #start(worker, operation, instruction) {
    const run = {
      id: this.randomUUID(),
      operation,
      settled: false,
      interrupted: false,
      done: null,
    };
    worker.currentRun = run;
    worker.runs.push(run);
    worker.status = "running";
    this.#emit(worker, run, { type: "run.started", operation });
    run.done = Promise.resolve()
      .then(() => worker.transport.run(worker.sessionId, instruction, {
        onNotification: (notification) => this.#emit(worker, run, {
          type: "run.output",
          notification,
        }),
      }))
      .then((value) => {
        if (run.interrupted) return this.#cancel(worker, run);
        const ok = value.finishReason === "completed";
        const completed = result(operation, {
          ok,
          code: ok ? 0 : 1,
          finishReason: value.finishReason,
          messageId: value.messageId,
        });
        run.settled = true;
        worker.lastResult = completed;
        worker.status = ok ? "idle" : "failed";
        if (value.output) this.#emit(worker, run, { type: "run.output", text: value.output });
        this.#emit(worker, run, {
          type: ok ? "run.completed" : "run.failed",
          ...completed,
        });
        return completed;
      })
      .catch(async (error) => {
        if (run.interrupted) return this.#cancel(worker, run);
        run.settled = true;
        worker.status = "failed";
        await worker.transport.terminate().catch(() => {});
        this.#emit(worker, run, {
          type: "run.failed",
          operation,
          message: error?.message || String(error),
          code: error?.code,
          stderrTail: worker.transport.stderrTail || "",
        });
        throw error;
      });
    return run;
  }

  #cancel(worker, run) {
    if (run.settled) return worker.lastResult;
    run.settled = true;
    const cancelled = result(run.operation, {
      ok: false,
      code: null,
      signal: "SIGTERM",
      interrupted: true,
      finishReason: "interrupted",
    });
    worker.lastResult = cancelled;
    worker.status = "interrupted";
    this.#emit(worker, run, { type: "run.cancelled", ...cancelled });
    return cancelled;
  }

  #emit(worker, run, event) {
    const normalized = normalizeRuntimeEvent({
      runtime_kind: this.runtime_kind,
      worker_id: worker.id,
      session_id: worker.sessionId,
      run_id: run?.id || null,
      sequence: worker.events.length + 1,
      event,
    });
    worker.events.push(normalized);
    worker.lastEventAt = Date.now();
    try { worker.onEvent?.(normalized, worker); } catch {}
    return normalized;
  }
}

export function createHarnessRuntime(options) {
  return new HarnessRuntime(options);
}
