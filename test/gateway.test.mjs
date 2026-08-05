import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { createGateway } from "../lib/gateway.mjs";
import { resolvePaths } from "../lib/paths.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function gatewayConfig(upstreamBaseUrl) {
  return {
    local: { host: "127.0.0.1", port: 10101, token: "9codex_local_test" },
    upstream: {
      base_url: `${upstreamBaseUrl}/v1`,
      api_key: "upstream-secret",
      default_model: "raw/model",
      image_model: "cx/gpt-5.5-image",
    },
  };
}

function routingFixture(paths, protocol = "responses_native") {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.modelMap, JSON.stringify({
    namespace: "9codex",
    public_to_upstream: { "9codex/raw-model": "raw/model" },
    upstream_protocols: {
      "raw/model": {
        protocol,
        capabilities: { streaming: true, tools: true },
        compatibility: {},
      },
    },
  }));
  fs.writeFileSync(paths.catalog, JSON.stringify({ models: [{ slug: "9codex/raw-model", visibility: "list" }] }));
}

test("native Responses routing preserves unknown JSON while replacing model and authorization", async (t) => {
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      encoding: req.headers["content-encoding"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths);
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const body = {
    model: "9codex/raw-model",
    input: [
      { role: "user", content: "hello" },
      { type: "future_input_item", payload: { keep: true } },
      {
        type: "function_call",
        id: "fc_empty",
        call_id: "call_empty",
        name: "",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_empty", output: "stale" },
    ],
    future_field: { nested: [1, 2, 3] },
  };

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: zlib.gzipSync(Buffer.from(JSON.stringify(body))),
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, "/v1/responses");
  assert.equal(captured.authorization, "Bearer upstream-secret");
  assert.equal(captured.encoding, undefined);
  assert.equal(captured.body.model, "raw/model");
  assert.deepEqual(captured.body.input, [
    { role: "user", content: "hello" },
    { type: "future_input_item", payload: { keep: true } },
  ]);
  assert.deepEqual(captured.body.future_field, { nested: [1, 2, 3] });
  assert.match(await response.text(), /response\.completed/);
});

test("gateway repairs a stale provider-prefixed model even when the stale model remains in the catalog", async (t) => {
  let upstreamModel;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamModel = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths);
  const routing = JSON.parse(fs.readFileSync(paths.modelMap, "utf8"));
  routing.upstream_protocols["openai/raw-model"] = routing.upstream_protocols["raw/model"];
  fs.writeFileSync(paths.modelMap, JSON.stringify(routing));
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "openai/raw-model", input: "continue old task", stream: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamModel, "raw/model");
});

test("rejects requests without the configured local bearer token", async (t) => {
  const upstream = http.createServer((req, res) => res.end());
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths);
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello" }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_local_token");
});

test("proxies image generation through the configured upstream image model", async (t) => {
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths);
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/images/generations`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "untrusted-model", prompt: "a red panda", size: "1024x1024" }),
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, "/v1/images/generations");
  assert.equal(captured.authorization, "Bearer upstream-secret");
  assert.equal(captured.accept, "application/json");
  assert.equal(captured.body.model, "cx/gpt-5.5-image");
  assert.equal(captured.body.prompt, "a red panda");
  assert.equal(captured.body.size, "1024x1024");
});

test("routes Chat-compatible models through chat/completions and emits Responses SSE", async (t) => {
  let capturedUrl;
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    capturedUrl = req.url;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"chat_1","created":10,"model":"raw/model","choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.end('data: {"id":"chat_1","created":10,"model":"raw/model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths, "chat_compat");
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello", stream: true }),
  });
  const text = await response.text();

  assert.equal(capturedUrl, "/v1/chat/completions");
  assert.equal(capturedBody.stream, true);
  assert.equal("stream_options" in capturedBody, false);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /event: response\.completed/);
});

test("automatically retries a model through Chat when its Responses endpoint is incompatible", async (t) => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    if (req.url === "/v1/responses") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Responses schema unsupported" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"chat_2","created":10,"model":"raw/model","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths, "auto");
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello", stream: true }),
  });
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(requests.map((request) => request.url), ["/v1/responses", "/v1/chat/completions"]);
  assert.equal(requests[1].body.stream, true);
  assert.equal("stream_options" in requests[1].body, false);
  assert.match(responseText, /response\.completed/);
});

test("surfaces a long-term upstream quota reason without letting Codex replace it with retry exhaustion", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "263",
    });
    res.end(JSON.stringify({
      error: {
        message: "[glm-cn/glm-5.2] [429]: {\"error\":{\"code\":\"1310\",\"message\":\"已达到 7 天使用上限，2026-08-04 11:34:50 后可继续使用。如需超限额按量付费使用，可联系管理员开通\"}} (reset after 4m 23s)",
      },
    }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths, "auto");
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello" }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "upstream_quota_exhausted");
  assert.equal(
    body.error.message,
    "已达到 7 天使用上限，2026-08-04 11:34:50 后可继续使用。",
  );
});

test("keeps temporary upstream rate limits retryable", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "5",
    });
    res.end(JSON.stringify({ error: { message: "Too many requests; retry shortly" } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths, "auto");
  const gateway = createGateway(gatewayConfig(upstreamUrl), paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello" }),
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(await response.json(), {
    error: { message: "Too many requests; retry shortly" },
  });
});
test("does not crash the gateway when the upstream stream aborts mid-body", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  routingFixture(paths);
  const gateway = createGateway(gatewayConfig("http://127.0.0.1:1/v1"), paths, {
    fetchImpl: async () => new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"chat_1","choices":[{"delta":{"content":"partial"}}]}\n\n'));
          controller.error(new Error("upstream aborted"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "9codex/raw-model", input: "hello", stream: true }),
  });
  // 上游中途断开时网关仍应优雅结束响应,而不是崩溃或挂起。
  await response.text();

  // The gateway process must still be alive and serving a fresh request.
  const probe = await fetch(`${gatewayUrl}/healthz`);
  assert.equal(probe.status, 200);
});
