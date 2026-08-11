import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../lib/config.mjs";
import { createGateway } from "../lib/gateway.mjs";
import { reconcileModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "9codex-team-events-")));
  const config = defaultConfig();
  config.local.token = "local-secret";
  config.upstream.base_url = `${upstreamUrl}/v1`;
  config.upstream.api_key = "upstream-secret";
  config.upstream.default_model = "raw/model";
  await reconcileModelState(paths, config, {
    authoritativeModels: [{
      id: "raw/model",
      protocol: "responses_native",
      context_window: 1_050_000,
    }],
  });
  const gateway = createGateway(config, paths, options);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  return gatewayUrl;
}

async function request(gatewayUrl, headers = {}, body = {}) {
  return fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-secret",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model: "raw/model",
      input: "body-secret",
      messages: [{ role: "user", content: "message-secret" }],
      api_key: "body-api-key",
      stream: false,
      ...body,
    }),
  });
}

test("publishes ordered, deduplicated, sanitized team identity events", async (t) => {
  const events = [];
  const callbackErrors = [];
  let throwOnce = true;
  const gatewayUrl = await fixture(t, async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "response", object: "response", output: [] }));
  }, {
    onTeamEvent(event) {
      events.push(event);
      if (event.type === "request_started" && throwOnce) {
        throwOnce = false;
        throw new Error("observer failed");
      }
    },
    onError(error) {
      callbackErrors.push(error.message);
    },
  });

  const first = await request(gatewayUrl, {
    "thread-id": "thread-1",
    "session-id": "session-1",
    "x-client-request-id": "request-1",
  });
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const second = await request(gatewayUrl, {
    "thread-id": "thread-1",
    "session-id": "session-2",
    "x-client-request-id": "request-2",
    "x-openai-subagent": "worker",
  });
  assert.equal(second.status, 200);
  await second.arrayBuffer();
  const withoutThread = await request(gatewayUrl, {
    "session-id": "session-3",
    "x-client-request-id": "request-3",
  });
  assert.equal(withoutThread.status, 200);
  await withoutThread.arrayBuffer();

  assert.deepEqual(events.map(({ type }) => type), [
    "thread_observed",
    "request_started",
    "request_completed",
    "request_started",
    "request_completed",
    "request_started",
    "request_completed",
  ]);
  assert.deepEqual(events.map(({ requestId, subagent, status }) => [requestId, subagent, status]), [
    ["request-1", false, null],
    ["request-1", false, null],
    ["request-1", false, 200],
    ["request-2", true, null],
    ["request-2", true, 200],
    ["request-3", false, null],
    ["request-3", false, 200],
  ]);
  assert.equal(events.at(-2).threadId, null);
  assert.equal(callbackErrors.includes("observer failed"), true);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "method",
      "path",
      "requestId",
      "sessionId",
      "status",
      "subagent",
      "threadId",
      "timestamp",
      "type",
    ]);
    assert.equal(event.path, "/v1/responses");
    assert.equal(event.method, "POST");
    assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /local-secret|upstream-secret|body-secret|message-secret|body-api-key|authorization|api_key|messages|input/i);
  }
});

test("publishes request_completed for upstream errors", async (t) => {
  const events = [];
  const gatewayUrl = await fixture(t, async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "retry later" } }));
  }, { onTeamEvent: (event) => events.push(event) });

  const response = await request(gatewayUrl, {
    "thread-id": "thread-error",
    "x-client-request-id": "request-error",
  });
  assert.equal(response.status, 429);
  await response.arrayBuffer();
  assert.deepEqual(events.map(({ type, status }) => [type, status]), [
    ["thread_observed", null],
    ["request_started", null],
    ["request_completed", 429],
  ]);
});

test("publishes request_completed for internal exceptions without changing the response", async (t) => {
  const events = [];
  const errors = [];
  const gatewayUrl = await fixture(t, (_req, res) => res.end(), {
    fetchImpl: async () => {
      throw new Error("upstream exploded");
    },
    onTeamEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });

  const response = await request(gatewayUrl, {
    "session-id": "session-failure",
    "x-client-request-id": "request-failure",
    "x-openai-subagent": "worker",
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "9codex_gateway_error");
  assert.deepEqual(events.map(({ type, threadId, subagent, status }) => ({
    type,
    threadId,
    subagent,
    status,
  })), [
    { type: "request_started", threadId: null, subagent: true, status: null },
    { type: "request_completed", threadId: null, subagent: true, status: 502 },
  ]);
  assert.deepEqual(errors, []);
});
