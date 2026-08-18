export const RUNTIME_KINDS = Object.freeze(["codex", "deepseek-harness"]);

const EVENT_TYPES = new Map([
  ["thread.started", "session.created"],
  ["session.started", "session.created"],
  ["session.created", "session.created"],
  ["run.started", "run.started"],
  ["turn.started", "run.started"],
  ["message", "run.output"],
  ["run.output", "run.output"],
  ["item.started", "run.output"],
  ["item.completed", "run.output"],
  ["adapter.stderr", "run.output"],
  ["run.completed", "run.completed"],
  ["turn.completed", "run.completed"],
  ["adapter.process_exit", "run.completed"],
  ["run.cancelled", "run.cancelled"],
  ["run.failed", "run.failed"],
  ["turn.failed", "run.failed"],
  ["error", "run.failed"],
  ["adapter.process_error", "run.failed"],
  ["adapter.jsonl_error", "run.failed"],
  ["session.closed", "session.closed"],
]);

const REQUIRED_METHODS = [
  "createWorker",
  "createThread",
  "sendInstruction",
  "readEvents",
  "waitWorker",
  "interruptWorker",
  "resumeWorker",
  "closeWorker",
  "resumeThread",
  "forgetWorker",
  "inspectWorker",
];

export function classifyRuntimeFailure(error = {}) {
  const code = error.code || null;
  const text = `${code || ""} ${error.message || ""}`.toLowerCase();
  const status = Number(error.status || text.match(/\b(?:http\s*)?(401|403|408|409|425|429|500|502|503|504)\b/)?.[1]) || null;
  let category = "worker_process_failed";
  let recoverable = false;
  if (/context (?:length|window)|context_limit|too many tokens/.test(text)) {
    category = "context_limit";
    recoverable = true;
  } else if (/upstream_quota_exhausted|quota (?:exceeded|exhausted)|usage limit/.test(text)) {
    category = "upstream_quota_exhausted";
  } else if (status === 401 || status === 403 || /invalid api key|authentication|unauthorized|forbidden/.test(text)) {
    category = "upstream_authentication_failed";
    recoverable = true;
  } else if (/model (?:not found|unavailable)|unknown model|unsupported model/.test(text)) {
    category = "model_unavailable";
    recoverable = true;
  } else if (status === 429 || /rate.?limit|retry later|too many requests/.test(text)) {
    category = "upstream_rate_limited";
    recoverable = true;
  } else if ([500, 502, 503, 504].includes(status) || /temporar|unavailable|connection reset|socket hang up|stream aborted|econn/.test(text)) {
    category = "upstream_transient_failure";
    recoverable = true;
  } else if (code === "HARNESS_REQUEST_TIMEOUT" || status === 408 || /timed? out|timeout/.test(text)) {
    category = "upstream_request_timeout";
    recoverable = true;
  } else if (/protocol|invalid json|json-rpc/.test(text)) {
    category = "runtime_protocol_failure";
    recoverable = true;
  }
  const retryAfter = text.match(/retry(?:-| )after[=: ]+(\d+)/i)?.[1]
    || text.match(/retry(?:ing)? (?:in|after) (\d+)\s*(ms|s|sec|seconds?|m|min|minutes?)/i)?.[1];
  const retryUnit = text.match(/retry(?:ing)? (?:in|after) \d+\s*(ms|s|sec|seconds?|m|min|minutes?)/i)?.[1];
  const retryAfterMs = retryAfter
    ? Number(retryAfter) * (/^m(?:in|inutes?)?$/i.test(retryUnit || "") ? 60_000 : retryUnit === "ms" ? 1 : 1_000)
    : null;
  return { category, recoverable, code, status, ...(retryAfterMs ? { retryAfterMs } : {}) };
}

export class RuntimeTimeoutError extends Error {
  constructor(workerId, timeoutMs) {
    super(`Worker ${workerId} did not exit within ${timeoutMs}ms`);
    this.name = "RuntimeTimeoutError";
    this.code = "RUNTIME_TIMEOUT";
  }
}

export function assertRuntimeKind(runtimeKind) {
  if (!RUNTIME_KINDS.includes(runtimeKind)) {
    throw new TypeError(
      `runtime_kind must be one of: ${RUNTIME_KINDS.join(", ")}`,
    );
  }
  return runtimeKind;
}

export function assertInstruction(instruction) {
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw new TypeError("instruction must be a non-empty string");
  }
  return instruction;
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("session_id must be a non-empty string");
  }
  return sessionId;
}

export function assertRuntimeOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  return options;
}

export function assertRuntimeLifecycle(runtime, label = "runtime") {
  if (!runtime || typeof runtime !== "object") {
    throw new TypeError(`${label} is required`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof runtime[method] !== "function") {
      throw new TypeError(`${label}.${method} must be a function`);
    }
  }
  return runtime;
}

export function normalizeRuntimeEvent(input) {
  assertRuntimeOptions(input);
  const runtimeKind = assertRuntimeKind(input.runtime_kind);
  const source = input.event;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("event must be an object");
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("sequence must be a positive integer");
  }

  let type = EVENT_TYPES.get(source.type) || "runtime.event";
  if (source.type === "adapter.process_exit") {
    type = source.interrupted
      ? "run.cancelled"
      : source.ok
        ? "run.completed"
        : "run.failed";
  }

  return {
    sequence: input.sequence,
    type,
    runtime_kind: runtimeKind,
    worker_id: input.worker_id || null,
    session_id: input.session_id
      || source.session_id
      || source.sessionId
      || source.thread_id
      || source.threadId
      || null,
    run_id: input.run_id || source.run_id || source.runId || null,
    data: source,
  };
}

export class RuntimeDriver {
  constructor(options) {
    assertRuntimeOptions(options);
    this.runtime_kind = assertRuntimeKind(options.runtime_kind);
    this.runtime = assertRuntimeLifecycle(options.runtime);
    if (this.runtime.runtime_kind !== this.runtime_kind) {
      throw new TypeError(
        `runtime.runtime_kind ${this.runtime.runtime_kind} does not match ${this.runtime_kind}`,
      );
    }
    this.workers = this.runtime.workers;
  }

  createWorker(...args) {
    return this.runtime.createWorker(...args);
  }

  createThread(...args) {
    return this.runtime.createThread(...args);
  }

  sendInstruction(...args) {
    return this.runtime.sendInstruction(...args);
  }

  readEvents(...args) {
    return this.runtime.readEvents(...args);
  }

  waitWorker(...args) {
    return this.runtime.waitWorker(...args);
  }

  interruptWorker(...args) {
    return this.runtime.interruptWorker(...args);
  }

  resumeWorker(...args) {
    return this.runtime.resumeWorker(...args);
  }

  closeWorker(...args) {
    return this.runtime.closeWorker(...args);
  }

  resumeThread(...args) {
    return this.runtime.resumeThread(...args);
  }

  forgetWorker(...args) {
    return this.runtime.forgetWorker(...args);
  }

  inspectWorker(...args) {
    return this.runtime.inspectWorker(...args);
  }
}
