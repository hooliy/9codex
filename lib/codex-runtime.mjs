import { createCodexAdapter } from "./codex-adapter.mjs";
import {
  RuntimeTimeoutError,
  assertInstruction,
  assertRuntimeLifecycle,
  assertRuntimeOptions,
  assertSessionId,
  normalizeRuntimeEvent,
} from "./runtime-driver.mjs";

export class CodexRuntime {
  constructor(options = {}) {
    assertRuntimeOptions(options);
    this.runtime_kind = "codex";
    const adapterOptions = { ...options };
    delete adapterOptions.adapter;
    this.adapter = assertRuntimeLifecycle(
      options.adapter || createCodexAdapter(adapterOptions),
      "adapter",
    );
    this.workers = this.adapter.workers;
  }

  createWorker(instruction, options = {}) {
    assertInstruction(instruction);
    assertRuntimeOptions(options);
    const onEvent = options.onEvent;
    const worker = this.adapter.createWorker(instruction, {
      ...options,
      onEvent: onEvent
        ? (event, activeWorker) => onEvent(
            this.#event(activeWorker, event, activeWorker.events.indexOf(event) + 1),
            activeWorker,
          )
        : undefined,
    });
    worker.runtime_kind = this.runtime_kind;
    return worker;
  }

  async createThread(instruction, options = {}) {
    assertInstruction(instruction);
    assertRuntimeOptions(options);
    const onEvent = options.onEvent;
    const worker = await this.adapter.createThread(instruction, {
      ...options,
      onEvent: onEvent
        ? (event, activeWorker) => onEvent(
            this.#event(activeWorker, event, activeWorker.events.indexOf(event) + 1),
            activeWorker,
          )
        : undefined,
    });
    worker.runtime_kind = this.runtime_kind;
    return worker;
  }

  sendInstruction(workerOrId, instruction) {
    assertInstruction(instruction);
    return this.adapter.sendInstruction(workerOrId, instruction);
  }

  readEvents(workerOrId, options = {}) {
    assertRuntimeOptions(options);
    const worker = this.#worker(workerOrId);
    const after = Number.isInteger(options.after) && options.after >= 0
      ? options.after
      : 0;
    return this.adapter.readEvents(worker, { after }).map(
      (event, index) => this.#event(worker, event, after + index + 1),
    );
  }

  async waitWorker(workerOrId, options = {}) {
    assertRuntimeOptions(options);
    try {
      return await this.adapter.waitWorker(workerOrId, options);
    } catch (error) {
      if (error?.code !== "CODEX_WORKER_TIMEOUT") throw error;
      const worker = this.#worker(workerOrId);
      throw new RuntimeTimeoutError(worker.id, options.timeoutMs);
    }
  }

  interruptWorker(workerOrId) {
    return this.adapter.interruptWorker(workerOrId);
  }

  resumeWorker(workerOrId, instruction) {
    assertInstruction(instruction);
    return this.adapter.resumeWorker(workerOrId, instruction);
  }

  closeWorker(workerOrId) {
    return this.adapter.closeWorker(workerOrId);
  }

  resumeThread(sessionId, instruction, options = {}) {
    assertSessionId(sessionId);
    assertInstruction(instruction);
    assertRuntimeOptions(options);
    const onEvent = options.onEvent;
    const worker = this.adapter.resumeThread(sessionId, instruction, {
      ...options,
      onEvent: onEvent
        ? (event, activeWorker) => onEvent(
            this.#event(activeWorker, event, activeWorker.events.indexOf(event) + 1),
            activeWorker,
          )
        : undefined,
    });
    worker.runtime_kind = this.runtime_kind;
    return worker;
  }

  forgetWorker(workerOrId) {
    return this.adapter.forgetWorker(workerOrId);
  }

  #worker(workerOrId) {
    if (typeof workerOrId !== "string") return workerOrId;
    const worker = this.workers?.get?.(workerOrId);
    if (!worker) throw new Error("Unknown Codex worker");
    return worker;
  }

  #event(worker, event, sequence) {
    return normalizeRuntimeEvent({
      runtime_kind: this.runtime_kind,
      worker_id: worker?.id,
      session_id: worker?.sessionId || worker?.threadId,
      run_id: worker?.currentRun?.id,
      sequence,
      event,
    });
  }
}

export function createCodexRuntime(options) {
  return new CodexRuntime(options);
}
