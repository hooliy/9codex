import readline from "node:readline";

if (process.env.HARNESS_FIXTURE_JSONRPC !== "1") process.exit(0);

const mode = process.env.HARNESS_FIXTURE_MODE || "success";
const sessions = new Map();

function send(value, split = false) {
  const line = `${JSON.stringify(value)}\n`;
  if (!split) return process.stdout.write(line);
  process.stdout.write(line.slice(0, 7));
  setTimeout(() => process.stdout.write(line.slice(7)), 2);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stderr.write("fixture initialized\n");
    if (mode === "echo-secret-stderr") {
      process.stderr.write(`${process.env.NINECODEX_HARNESS_API_KEY}\n`);
    }
    if (mode === "invalid-initialize-response") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { serverInfo: { name: "fixture-runtime" } },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        serverInfo: { name: "fixture-runtime", version: "0.1.0-rc.5" },
      },
    }, true);
    return;
  }
  if (request.method === "shutdown") {
    if (mode === "ignore-shutdown") return;
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (request.method !== "session/prompt") return;
  const sessionId = request.params.sessionId;
  const turn = (sessions.get(sessionId) || 0) + 1;
  sessions.set(sessionId, turn);
  if (mode === "rpc-failure") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "fixture failure" },
    });
    return;
  }
  if (mode === "timeout") return;
  if (mode === "stalled-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    notify("session.status", { sessionId, status: "running" });
    return;
  }
  if (mode === "invalid-json-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => process.stdout.write("{invalid-json\n"), 5);
    return;
  }
  if (mode === "invalid-jsonrpc-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => send({ jsonrpc: "1.0", method: "session.status", params: { sessionId, status: "idle" } }), 5);
    return;
  }
  if (mode === "malformed-session-status-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => notify("session.status", { sessionId, status: 42 }), 5);
    return;
  }
  if (mode === "malformed-session-event-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => notify("session.event", { sessionId, event: null }), 5);
    return;
  }
  if (mode === "malformed-subagent-started-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => notify("subagent.started", { parentSessionId: sessionId }), 5);
    return;
  }
  if (mode === "malformed-subagent-finished-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => notify("subagent.finished", {
      parentSessionId: sessionId,
      childSessionId: `${sessionId}-child`,
      status: "ok",
    }), 5);
    return;
  }
  if (mode === "unknown-notification-after-prompt") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
    setTimeout(() => notify("session.compat", { sessionId }), 5);
    return;
  }
  if (mode === "invalid-prompt-response") {
    send({ jsonrpc: "2.0", id: request.id, result: { messageId: "" } });
    return;
  }
  notify("session.status", { sessionId, status: "running" });
  notify("session.event", {
    sessionId,
    event: {
      type: "assistant/chunk",
      seq: 1,
      time: 0,
      data: { chunk: { type: "text-delta", text: `turn-${turn}` } },
    },
  });
  if (mode === "chunk-and-message") {
    notify("session.event", {
      sessionId,
      event: {
        type: "assistant/message",
        seq: 2,
        time: 0,
        data: {
          message: {
            content: [{ type: "text", text: `turn-${turn}` }],
          },
        },
      },
    });
  }
  notify("subagent.started", { parentSessionId: sessionId, childSessionId: `${sessionId}-child` });
  notify("subagent.finished", {
    parentSessionId: sessionId,
    childSessionId: `${sessionId}-child`,
    status: "ok",
    stopReason: "completed",
  });
  notify("session.event", {
    sessionId,
    event: {
      type: "turn/end",
      seq: mode === "chunk-and-message" ? 3 : 2,
      time: 0,
      data: { turn, reason: { kind: mode === "turn-failure" ? "error" : "completed" } },
    },
  });
  notify("session.status", { sessionId, status: "idle" });
  send({ jsonrpc: "2.0", id: request.id, result: { messageId: `message-${turn}` } });
});
