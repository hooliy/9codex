import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export class CodexAdapterTimeoutError extends Error {
  constructor(workerId, timeoutMs) {
    super(`Worker ${workerId} did not exit within ${timeoutMs}ms`);
    this.name = "CodexAdapterTimeoutError";
    this.code = "CODEX_WORKER_TIMEOUT";
  }
}

function assertInstruction(instruction) {
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw new TypeError("instruction must be a non-empty string");
  }
}

function processResult(run, code, signal) {
  return {
    operation: run.operation,
    code,
    signal,
    ok: code === 0,
    interrupted: run.interrupted,
  };
}

function safeEnvironment(environment = process.env) {
  const allowed = new Set([
    "HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot", "CODEX_HOME",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => allowed.has(key)),
  );
}

export function resolveCodexCommand(options = {}) {
  if (options.command) return options.command;
  const candidates = process.platform === "darwin"
    ? ["/Applications/ChatGPT.app/Contents/Resources/codex", "/usr/local/bin/codex", "/opt/homebrew/bin/codex"]
    : process.platform === "win32"
      ? [
          `${process.env.LOCALAPPDATA || ""}\\Programs\\ChatGPT\\resources\\codex.exe`,
          "codex.exe",
        ]
      : ["/usr/local/bin/codex", "/usr/bin/codex", "codex"];
  return candidates.find((candidate) => candidate.includes("/") && fs.existsSync(candidate))
    || candidates.at(-1);
}

export class CodexAdapter {
  constructor(options = {}) {
    this.command = resolveCodexCommand(options);
    this.spawn = options.spawn || spawnProcess;
    this.randomUUID = options.randomUUID || randomUUID;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.workers = new Map();
    this.ownedProcesses = new Set();
  }

  createWorker(instruction, options = {}) {
    assertInstruction(instruction);
    const worker = {
      id: this.randomUUID(),
      threadId: null,
      sessionId: null,
      cwd: options.cwd,
      status: "starting",
      events: [],
      runs: [],
      currentRun: null,
      lastResult: null,
      lastEventAt: Date.now(),
      execution: {
        env: options.env || safeEnvironment(),
        approvalPolicy: options.approvalPolicy || "never",
        ignoreUserConfig: options.ignoreUserConfig !== false,
        ignoreRules: options.ignoreRules !== false,
      },
      onEvent: options.onEvent,
    };
    this.workers.set(worker.id, worker);
    const args = options.dangerouslyBypassApprovalsAndSandbox
      ? ["exec", "--dangerously-bypass-approvals-and-sandbox", ...(options.extraArgs || []), "--json", "-"]
      : [
          "--ask-for-approval",
          options.approvalPolicy || "never",
          "exec",
          "--sandbox",
          options.sandbox || "workspace-write",
          ...(worker.execution.ignoreUserConfig ? ["--ignore-user-config"] : []),
          ...(worker.execution.ignoreRules ? ["--ignore-rules"] : []),
          ...(options.extraArgs || []),
          "--json",
          "-",
        ];
    this.#start(worker, "create", args, instruction, true, { env: worker.execution.env });
    return worker;
  }

  async createThread(instruction, options = {}) {
    let started;
    const threadStarted = new Promise((resolve, reject) => {
      const timer = this.setTimeout(
        () => reject(new Error("Codex thread did not start within 15 seconds")),
        options.threadStartTimeoutMs || 15_000,
      );
      started = (worker) => {
        this.clearTimeout(timer);
        resolve(worker);
      };
    });
    const onEvent = options.onEvent;
    const worker = this.createWorker(instruction, {
      ...options,
      onEvent: (event, activeWorker) => {
        onEvent?.(event, activeWorker);
        if (event?.type !== "thread.started" || !activeWorker.threadId) return;
        started(activeWorker);
        this.terminateWorker(activeWorker);
      },
    });
    try {
      await threadStarted;
      await this.waitWorker(worker);
      this.forgetWorker(worker);
    } catch (error) {
      this.interruptWorker(worker);
      throw error;
    }
    return worker;
  }

  forgetWorker(workerOrId) {
    const worker = typeof workerOrId === "string" ? this.workers.get(workerOrId) : workerOrId;
    if (!worker || worker.currentRun && !worker.currentRun.settled) return false;
    return this.workers.delete(worker.id);
  }

  terminateWorker(workerOrId) {
    const worker = typeof workerOrId === "string" ? this.workers.get(workerOrId) : workerOrId;
    const run = worker?.currentRun;
    if (!run || run.settled || !this.ownedProcesses.has(run.process)) return false;
    run.interrupted = true;
    worker.status = "interrupting";
    return run.process.kill("SIGKILL");
  }

  sendInstruction(workerOrId, instruction) {
    return this.resumeWorker(workerOrId, instruction);
  }

  readEvents(workerOrId, options = {}) {
    const worker = this.#worker(workerOrId);
    const after = Number.isInteger(options.after) && options.after >= 0
      ? options.after
      : 0;
    return worker.events.slice(after);
  }

  async waitWorker(workerOrId, options = {}) {
    const worker = this.#worker(workerOrId);
    const run = worker.currentRun;
    if (!run) {
      if (worker.lastResult) return worker.lastResult;
      throw new Error(`Worker ${worker.id} has no process to wait for`);
    }

    const timeoutMs = options.timeoutMs;
    if (timeoutMs === undefined) return run.done;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }

    let timer;
    try {
      return await Promise.race([
        run.done,
        new Promise((_, reject) => {
          timer = this.setTimeout(() => {
            this.interruptWorker(worker);
            reject(new CodexAdapterTimeoutError(worker.id, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) this.clearTimeout(timer);
    }
  }

  interruptWorker(workerOrId) {
    const worker = typeof workerOrId === "string"
      ? this.workers.get(workerOrId)
      : workerOrId;
    if (!worker || this.workers.get(worker.id) !== worker) return false;
    const run = worker.currentRun;
    if (!run || run.settled || !this.ownedProcesses.has(run.process)) return false;
    run.interrupted = true;
    worker.status = "interrupting";
    return run.process.kill("SIGINT");
  }

  resumeWorker(workerOrId, instruction) {
    assertInstruction(instruction);
    const worker = this.#worker(workerOrId);
    if (worker.status === "closed") throw new Error(`Worker ${worker.id} is closed`);
    if (worker.currentRun && !worker.currentRun.settled) {
      throw new Error(`Worker ${worker.id} is already running`);
    }
    const sessionId = worker.sessionId || worker.threadId;
    if (!sessionId) throw new Error(`Worker ${worker.id} has no Codex session id`);
    this.#start(
      worker,
      "resume",
      [
        "--ask-for-approval",
        worker.execution.approvalPolicy,
        "exec",
        "resume",
        ...(worker.execution.ignoreUserConfig ? ["--ignore-user-config"] : []),
        ...(worker.execution.ignoreRules ? ["--ignore-rules"] : []),
        "--json",
        sessionId,
        "-",
      ],
      instruction,
      true,
      { env: worker.execution.env },
    );
    return worker;
  }

  async closeWorker(workerOrId) {
    const worker = this.#worker(workerOrId);
    if (worker.status === "closed") return worker.lastResult;
    if (worker.currentRun && !worker.currentRun.settled) {
      this.interruptWorker(worker);
      await worker.currentRun.done;
    }
    const sessionId = worker.sessionId || worker.threadId;
    if (!sessionId) throw new Error(`Worker ${worker.id} has no Codex session id`);
    const run = this.#start(worker, "archive", ["archive", sessionId], null, false, {
      env: worker.execution.env,
    });
    const result = await run.done;
    if (result.ok) worker.status = "closed";
    return result;
  }

  #worker(workerOrId) {
    const worker = typeof workerOrId === "string"
      ? this.workers.get(workerOrId)
      : workerOrId;
    if (!worker || this.workers.get(worker.id) !== worker) {
      throw new Error("Unknown Codex worker");
    }
    return worker;
  }

  #start(worker, operation, args, instruction, jsonl, spawnOptions = {}) {
    const process = this.spawn(this.command, args, {
      cwd: worker.cwd,
      env: spawnOptions.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const run = {
      id: this.randomUUID(),
      operation,
      process,
      interrupted: false,
      settled: false,
      stdout: new StringDecoder("utf8"),
      stdoutBuffer: "",
      stderr: new StringDecoder("utf8"),
      stderrBuffer: "",
      jsonl,
    };
    run.done = new Promise((resolve) => {
      run.resolve = resolve;
    });
    worker.runs.push(run);
    worker.currentRun = run;
    worker.status = "running";
    this.ownedProcesses.add(process);

    process.stdout?.on("data", (chunk) => {
      const text = run.stdout.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (jsonl) this.#consumeJsonl(worker, run, text);
      else run.stdoutBuffer += text;
    });
    process.stderr?.on("data", (chunk) => {
      run.stderrBuffer += run.stderr.write(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    process.once("error", (error) => {
      worker.events.push({
        type: "adapter.process_error",
        operation,
        message: error.message,
        code: error.code,
      });
    });
    process.once("close", (code, signal) => {
      if (run.settled) return;
      run.settled = true;
      this.ownedProcesses.delete(process);
      const stdoutTail = run.stdout.end();
      if (jsonl) {
        this.#consumeJsonl(worker, run, stdoutTail, true);
      } else {
        run.stdoutBuffer += stdoutTail;
      }
      run.stderrBuffer += run.stderr.end();
      if (run.stderrBuffer) {
        worker.events.push({
          type: "adapter.stderr",
          operation,
          text: run.stderrBuffer,
        });
      }
      const result = processResult(run, code, signal);
      worker.lastResult = result;
      worker.status = operation === "archive"
        ? (result.ok ? "closed" : "archive_failed")
        : (run.interrupted ? "interrupted" : "exited");
      worker.events.push({ type: "adapter.process_exit", ...result });
      run.resolve(result);
    });

    if (instruction !== null) {
      process.stdin?.end(instruction);
    } else {
      process.stdin?.end();
    }
    return run;
  }

  #consumeJsonl(worker, run, text, final = false) {
    run.stdoutBuffer += text;
    const lines = run.stdoutBuffer.split("\n");
    run.stdoutBuffer = final ? "" : lines.pop();
    if (final && lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line);
        worker.events.push(event);
        worker.lastEventAt = Date.now();
        this.#captureSession(worker, event);
        try { worker.onEvent?.(event, worker); } catch {}
      } catch (error) {
        worker.events.push({
          type: "adapter.jsonl_error",
          operation: run.operation,
          raw: line,
          message: error.message,
        });
      }
    }
    if (final && run.stdoutBuffer.trim() !== "") {
      throw new Error("unreachable");
    }
  }

  #captureSession(worker, event) {
    const threadId = event?.thread_id
      || event?.threadId
      || event?.thread?.id;
    const sessionId = event?.session_id
      || event?.sessionId
      || event?.session?.id
      || event?.conversation_id;
    if (threadId) worker.threadId = threadId;
    if (sessionId) worker.sessionId = sessionId;
    if (!worker.sessionId && event?.type === "thread.started" && threadId) {
      worker.sessionId = threadId;
    }
  }

  resumeThread(sessionId, instruction, options = {}) {
    assertInstruction(instruction);
    assertInstruction(sessionId);
    const worker = {
      id: this.randomUUID(),
      threadId: sessionId,
      sessionId,
      cwd: options.cwd,
      status: "starting",
      events: [],
      runs: [],
      currentRun: null,
      lastResult: null,
      lastEventAt: Date.now(),
      execution: {
        env: options.env || safeEnvironment(),
        approvalPolicy: options.approvalPolicy || "never",
        ignoreUserConfig: options.ignoreUserConfig === true,
        ignoreRules: options.ignoreRules !== false,
      },
      onEvent: options.onEvent,
    };
    this.workers.set(worker.id, worker);
    this.resumeWorker(worker, instruction);
    return worker;
  }
}

export function createCodexAdapter(options) {
  return new CodexAdapter(options);
}

const defaultAdapter = new CodexAdapter();

export const createWorker = (...args) => defaultAdapter.createWorker(...args);
export const sendInstruction = (...args) => defaultAdapter.sendInstruction(...args);
export const readEvents = (...args) => defaultAdapter.readEvents(...args);
export const waitWorker = (...args) => defaultAdapter.waitWorker(...args);
export const interruptWorker = (...args) => defaultAdapter.interruptWorker(...args);
export const resumeWorker = (...args) => defaultAdapter.resumeWorker(...args);
export const closeWorker = (...args) => defaultAdapter.closeWorker(...args);
export const resumeThread = (...args) => defaultAdapter.resumeThread(...args);
