import { spawn as spawnProcess } from "node:child_process";

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validateNotification(message) {
  const { method, params } = message;
  if (!isRecord(params)) {
    throw new HarnessProtocolError(`${method} notification contains invalid params`);
  }
  if (method === "session.event") {
    if (!hasText(params.sessionId) || !isRecord(params.event) || !hasText(params.event.type)) {
      throw new HarnessProtocolError("session.event notification contains invalid params");
    }
    return;
  }
  if (method === "session.status") {
    if (!hasText(params.sessionId) || !["running", "idle"].includes(params.status)) {
      throw new HarnessProtocolError("session.status notification contains invalid params");
    }
    return;
  }
  if (method === "subagent.started") {
    if (!hasText(params.parentSessionId) || !hasText(params.childSessionId)) {
      throw new HarnessProtocolError("subagent.started notification contains invalid params");
    }
    return;
  }
  if (method === "subagent.finished") {
    if (
      !hasText(params.parentSessionId)
      || !hasText(params.childSessionId)
      || !hasText(params.status)
      || !hasText(params.stopReason)
    ) {
      throw new HarnessProtocolError("subagent.finished notification contains invalid params");
    }
    return;
  }
  throw new HarnessProtocolError(`unknown JSON-RPC notification: ${method}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class HarnessTransportClosedError extends Error {
  constructor(message = "Harness transport closed") {
    super(message);
    this.name = "HarnessTransportClosedError";
    this.code = "HARNESS_TRANSPORT_CLOSED";
  }
}

export class HarnessRequestTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`Harness request ${method} timed out after ${timeoutMs}ms`);
    this.name = "HarnessRequestTimeoutError";
    this.code = "HARNESS_REQUEST_TIMEOUT";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class HarnessProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HarnessProtocolError";
    this.code = "HARNESS_PROTOCOL_ERROR";
    Object.assign(this, details);
  }
}

export class HarnessJsonRpcTransport {
  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("options must be an object");
    }
    this.command = requireText(options.command || "dsh-jsonrpc-agent", "command");
    this.args = options.args ?? [];
    if (!Array.isArray(this.args) || this.args.some((value) => typeof value !== "string")) {
      throw new TypeError("args must be an array of strings");
    }
    this.cwd = requireText(options.cwd || process.cwd(), "cwd");
    this.sessionRoot = requireText(options.sessionRoot, "sessionRoot");
    this.cordisConfig = options.cordisConfig ?? null;
    if (this.cordisConfig !== null) requireText(this.cordisConfig, "cordisConfig");
    this.provider = requireText(options.provider, "provider");
    this.model = requireText(options.model, "model");
    this.maxTokens = options.maxTokens ?? null;
    if (this.maxTokens !== null) requirePositiveInteger(this.maxTokens, "maxTokens");
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? 300_000,
      "requestTimeoutMs",
    );
    this.shutdownTimeoutMs = requirePositiveInteger(
      options.shutdownTimeoutMs ?? 1_000,
      "shutdownTimeoutMs",
    );
    this.spawn = options.spawn || spawnProcess;
    this.env = { ...(options.env || {}) };
    this.child = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stderrLimit = options.stderrLimit ?? 32_768;
    this.initialized = null;
    this.closed = false;
    this.exit = deferred();
    this.fatal = deferred();
    this.fatal.promise.catch(() => {});
    this.fatalError = null;
    this.fatalReap = null;
    this.secrets = [this.env.NINECODEX_HARNESS_API_KEY]
      .filter((value) => typeof value === "string" && value.length > 0);
  }

  get stderrTail() {
    return this.stderrBuffer;
  }

  async start() {
    if (this.child) return this;
    if (this.closed) throw new HarnessTransportClosedError();
    const env = {
      ...process.env,
      ...this.env,
      DSH_CWD: this.cwd,
      DSH_SESSION_ROOT: this.sessionRoot,
    };
    if (this.cordisConfig) env.DSH_CORDIS_CONFIG = this.cordisConfig;
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${this.#redact(chunk)}`.slice(-this.stderrLimit);
    });
    child.on("error", (error) => this.#finish(error));
    child.on("close", (code, signal) => this.#finish(null, code, signal));
    child.stdin.on("error", () => {});
    return this;
  }

  async initialize() {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this.start();
      const params = {
        cwd: this.cwd,
        provider: this.provider,
        model: this.model,
      };
      if (this.maxTokens !== null) params.maxTokens = this.maxTokens;
      const result = await this.request("initialize", params);
      if (
        !result
        || typeof result !== "object"
        || Array.isArray(result)
        || !result.serverInfo
        || typeof result.serverInfo !== "object"
        || !hasText(result.serverInfo.name)
        || !hasText(result.serverInfo.version)
      ) {
        const error = new HarnessProtocolError("initialize returned invalid serverInfo");
        await this.#failProtocol(error);
        throw error;
      }
      return result;
    })();
    return this.initialized;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    requireText(method, "method");
    requirePositiveInteger(timeoutMs, "timeoutMs");
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.child || this.closed || this.child.exitCode !== null) {
      return Promise.reject(new HarnessTransportClosedError());
    }
    const id = String(this.nextId++);
    const pending = deferred();
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      pending.reject(new HarnessRequestTimeoutError(method, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { ...pending, timer, method });
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    this.child.stdin.write(line, (error) => {
      if (!error) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    });
    return pending.promise;
  }

  async prompt(sessionId, instruction) {
    requireText(sessionId, "sessionId");
    requireText(instruction, "instruction");
    await this.initialize();
    const result = await this.request("session/prompt", {
      sessionId,
      contentBlocks: [{ type: "text", text: instruction }],
    });
    if (!result || typeof result.messageId !== "string" || result.messageId.trim() === "") {
      const error = new HarnessProtocolError("session/prompt returned invalid messageId");
      await this.#failProtocol(error);
      throw error;
    }
    return result;
  }

  async run(sessionId, instruction, options = {}) {
    requireText(sessionId, "sessionId");
    requireText(instruction, "instruction");
    const completion = deferred();
    completion.promise.catch(() => {});
    const events = [];
    const chunks = [];
    let message = "";
    let seenRunning = false;
    let seenTurnEnd = false;
    let finishReason = null;
    let idle = false;
    const onNotification = (notification) => {
      options.onNotification?.(notification);
      const params = notification.params || {};
      const target = params.sessionId === sessionId;
      if (!target) return;
      if (notification.method === "session.status") {
        if (params.status === "running") seenRunning = true;
        if (params.status === "idle") idle = true;
      }
      if (notification.method === "session.event") {
        const event = params.event;
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          this.#failProtocol(new HarnessProtocolError("session.event contains invalid event"));
          return;
        }
        events.push(event);
        const text = event.type === "assistant/chunk"
          ? event.data?.chunk?.type === "text-delta" && event.data.chunk.text
          : event.type === "assistant/message"
            ? event.data?.message?.content
              ?.filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("")
            : null;
        if (text && event.type === "assistant/chunk") chunks.push(text);
        if (text && event.type === "assistant/message") message = text;
        if (event.type === "turn/end") {
          finishReason = event.data?.reason?.kind;
          if (typeof finishReason !== "string" || finishReason.trim() === "") {
            this.#failProtocol(new HarnessProtocolError("turn/end missing reason.kind"));
            return;
          }
          seenTurnEnd = true;
        }
      }
      if (seenRunning && seenTurnEnd && idle) {
        completion.resolve({ finishReason, events, output: message || chunks.join("") });
      }
    };
    this.listeners.add(onNotification);
    try {
      const { messageId } = await this.prompt(sessionId, instruction);
      const result = await Promise.race([
        completion.promise,
        this.fatal.promise,
        this.exit.promise.then(({ code, signal }) => {
          throw new HarnessTransportClosedError(
            `Harness process exited before run completion${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
          );
        }),
      ]);
      return { sessionId, messageId, ...result };
    } finally {
      this.listeners.delete(onNotification);
    }
  }

  async shutdown() {
    if (this.closed) return this.exit.promise;
    if (!this.child) {
      this.closed = true;
      this.exit.resolve({ code: null, signal: null });
      return this.exit.promise;
    }
    try {
      await this.request("shutdown", {}, this.shutdownTimeoutMs);
    } catch {}
    try { this.child.stdin.end(); } catch {}
    const graceful = await Promise.race([
      this.exit.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), this.shutdownTimeoutMs)),
    ]);
    if (!graceful) await this.terminate();
    return this.exit.promise;
  }

  async terminate() {
    if (!this.child || this.closed) return this.exit.promise;
    this.child.kill("SIGTERM");
    const terminated = await Promise.race([
      this.exit.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), this.shutdownTimeoutMs)),
    ]);
    if (!terminated && !this.closed) this.child.kill("SIGKILL");
    return this.exit.promise;
  }

  #consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        this.#failProtocol(new HarnessProtocolError(
          "invalid JSONL from Harness",
          { cause, line: this.#redact(line) },
        ));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.#failProtocol(new HarnessProtocolError("invalid JSON-RPC message"));
        return;
      }
      if (message.jsonrpc !== "2.0") {
        this.#failProtocol(new HarnessProtocolError("invalid JSON-RPC version"));
        return;
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(String(message.id));
        if (!entry) continue;
        const hasResult = Object.hasOwn(message, "result");
        const hasError = Object.hasOwn(message, "error");
        if (hasResult === hasError) {
          this.#failProtocol(new HarnessProtocolError("invalid JSON-RPC response"));
          return;
        }
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (hasError) {
          if (
            !message.error
            || typeof message.error !== "object"
            || Array.isArray(message.error)
            || typeof message.error.message !== "string"
          ) {
            this.#failProtocol(new HarnessProtocolError("invalid JSON-RPC error response"));
            return;
          }
          const error = new Error(
            this.#redact(message.error.message || `Harness RPC ${entry.method} failed`),
          );
          error.name = "HarnessJsonRpcError";
          error.code = message.error.code;
          error.data = message.error.data;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method !== "string" || message.method.trim() === "") {
        this.#failProtocol(new HarnessProtocolError("invalid JSON-RPC notification"));
        return;
      }
      try {
        validateNotification(message);
      } catch (error) {
        this.#failProtocol(error);
        return;
      }
      for (const listener of [...this.listeners]) {
        try { listener(message); } catch {}
      }
    }
  }

  #rejectAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  #failProtocol(error) {
    if (!this.fatalError) {
      this.fatalError = error;
      this.#rejectAll(error);
      this.fatal.reject(error);
      this.fatalReap = this.terminate().catch(() => this.exit.promise);
    }
    return this.fatalReap || this.exit.promise;
  }

  #redact(value) {
    let text = String(value);
    for (const secret of this.secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }

  #finish(error, code = null, signal = null) {
    if (this.closed) return;
    this.closed = true;
    const failure = this.fatalError || error || new HarnessTransportClosedError(
      `Harness process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
    );
    this.#rejectAll(failure);
    this.exit.resolve({ code, signal, error: error || null, stderrTail: this.stderrTail });
  }
}

export function createHarnessJsonRpcTransport(options) {
  return new HarnessJsonRpcTransport(options);
}
