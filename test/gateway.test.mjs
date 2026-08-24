import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { defaultConfig } from "../lib/config.mjs";
import { createGateway } from "../lib/gateway.mjs";
import { reconcileModelState } from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function gatewayConfig(upstreamBaseUrl) {
  const config = defaultConfig();
  config.local.token = "9codex_local_test";
  config.upstream.base_url = `${upstreamBaseUrl}/v1`;
  config.upstream.api_key = "upstream-secret";
  config.upstream.default_model = "raw/model";
  config.upstream.image_model = "cx/gpt-5.5-image";
  return config;
}

async function routingFixture(paths, config, protocol = "responses_native") {
  return reconcileModelState(paths, config, {
    authoritativeModels: [{
      id: config.upstream.default_model,
      protocol,
      context_window: 1_050_000,
      capabilities: { streaming: true, tools: true },
    }],
  });
}

test("health readiness tracks config/catalog/modelMap consistency", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://router.example/v1";
  config.upstream.api_key = "secret";
  config.upstream.default_model = "model-a";
  const active = await reconcileModelState(paths, config, {
    authoritativeModels: [{ id: "model-a", context_window: 1_050_000 }],
  });
  const gateway = createGateway(active.config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const healthy = await (await fetch(`${gatewayUrl}/healthz`)).json();
  assert.equal(healthy.ready, true);
  assert.equal(healthy.active_requests, 0);
  assert.equal(healthy.model_count, 1);
  fs.writeFileSync(paths.modelMap, JSON.stringify({ namespace: "9codex" }));
  const unhealthy = await (await fetch(`${gatewayUrl}/healthz`)).json();
  assert.equal(unhealthy.ok, true);
  assert.equal(unhealthy.ready, false);
  assert.equal(unhealthy.model_count, 0);
  assert.match(unhealthy.error, /model map.*inconsistent/i);
});

test("gateway model endpoints always expose at least one validated model", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig("https://router.example");
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const headers = { authorization: "Bearer 9codex_local_test" };

  const apiList = await (await fetch(`${gatewayUrl}/v1/models`, { headers })).json();
  const desktopList = await (
    await fetch(`${gatewayUrl}/v1/models?client_version=test`, { headers })
  ).json();

  assert.equal(apiList.data.length, 1);
  assert.equal(apiList.data[0].id, "raw/model");
  assert.equal(desktopList.models.length, 1);
  assert.equal(desktopList.models[0].slug, "raw/model");
});

test("health counts authenticated model requests until response completion", async (t) => {
  let releaseUpstream;
  const upstreamReleased = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    await upstreamReleased;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => {
    releaseUpstream();
    return new Promise((resolve) => upstream.close(resolve));
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const request = fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "raw/model", input: "hello", stream: false }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await (await fetch(`${gatewayUrl}/healthz`)).json()).active_requests, 1);
  releaseUpstream();
  assert.equal((await request).status, 200);
  assert.equal((await (await fetch(`${gatewayUrl}/healthz`)).json()).active_requests, 0);
});

test("gateway returns retryable 503 while model-state transaction lock is active", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig("https://router.example");
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  fs.writeFileSync(
    path.join(paths.stateDir, "model-state.lock"),
    `${JSON.stringify({ pid: process.pid })}\n`,
  );

  const response = await fetch(`${gatewayUrl}/v1/models`, {
    headers: { authorization: "Bearer 9codex_local_test" },
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), {
    error: {
      code: "model_state_unavailable",
      message: "Model state is updating or inconsistent; retry shortly",
    },
  });
  fs.rmSync(path.join(paths.stateDir, "model-state.lock"), { force: true });
});

test("gateway returns retryable 503 instead of routing an inconsistent model state", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  fs.writeFileSync(paths.modelMap, JSON.stringify({ namespace: "9codex" }));
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "raw/model", input: "hello" }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal((await response.json()).error.code, "model_state_unavailable");
  assert.equal(upstreamRequests, 0);
});

test("gateway routes from one latest committed config/catalog/modelMap snapshot", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const initial = gatewayConfig("https://old.example");
  const { config: active } = await routingFixture(paths, initial);
  let captured;
  const gateway = createGateway(active, paths, {
    fetchImpl: async (url, options) => {
      captured = {
        url: String(url),
        authorization: options.headers.authorization,
        model: JSON.parse(options.body).model,
      };
      return new Response(JSON.stringify({ id: "resp_test", object: "response", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const next = structuredClone(active);
  next.upstream.base_url = "https://new.example/v1";
  next.upstream.api_key = "new-secret";
  next.upstream.default_model = "new/model";
  await reconcileModelState(paths, active, {
    candidateConfig: next,
    authoritativeModels: [{
      id: "new/model",
      protocol: "responses_native",
      context_window: 1_050_000,
    }],
  });

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "new/model", input: "hello", stream: false }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    url: "https://new.example/v1/responses",
    authorization: "Bearer new-secret",
    model: "new/model",
  });
});

test("native Responses routing strips client identity while preserving correlation headers", async (t) => {
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      encoding: req.headers["content-encoding"],
      userAgent: req.headers["user-agent"],
      originator: req.headers.originator,
      sessionId: req.headers["session-id"],
      threadId: req.headers["thread-id"],
      clientRequestId: req.headers["x-client-request-id"],
      subagent: req.headers["x-openai-subagent"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const body = {
    model: "raw/model",
    service_tier: "priority",
    input: [
      { type: "message", id: "item_9f6c2eaba8c9393522160fa0", role: "user", content: "hello" },
      {
        type: "reasoning",
        id: "rs_legacy",
        summary: [{ type: "summary_text", text: "private reasoning" }],
        encrypted_content: "gAAA-invalid-for-the-routed-model",
      },
      {
        type: "function_call",
        call_id: "call_valid",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      { type: "reasoning", encrypted_content: "gAAA-also-invalid" },
      { type: "function_call_output", call_id: "call_valid", output: "contents" },
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
    tools: [
      { type: "custom", name: "apply_patch", format: { type: "grammar" } },
      { type: "namespace", name: "multi_agent_v1", tools: [] },
      { type: "namespace", name: "mcp__9codex", tools: [] },
      { type: "web_search", external_web_access: true },
    ],
    parallel_tool_calls: true,
    future_field: { nested: [1, 2, 3] },
  };

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
      "content-encoding": "gzip",
      "user-agent": "codex_cli_rs/0.146.1 (Mac OS 15.6.0; arm64)",
      originator: "codex_chatgpt_desktop",
      "session-id": "session-1",
      "thread-id": "thread-1",
      "x-client-request-id": "request-1",
      "x-openai-subagent": "review",
    },
    body: zlib.gzipSync(Buffer.from(JSON.stringify(body))),
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, "/v1/responses");
  assert.equal(captured.authorization, "Bearer upstream-secret");
  assert.equal(captured.encoding, undefined);
  assert.equal(captured.userAgent, "node");
  assert.equal(captured.originator, undefined);
  assert.equal(captured.sessionId, "session-1");
  assert.equal(captured.threadId, "thread-1");
  assert.equal(captured.clientRequestId, "request-1");
  assert.equal(captured.subagent, "review");
  assert.equal(captured.body.model, "raw/model");
  assert.equal("service_tier" in captured.body, false);
  assert.deepEqual(captured.body.input, [
    { type: "message", role: "user", content: "hello" },
    {
      type: "function_call",
      call_id: "call_valid",
      name: "read_file",
      arguments: "{\"path\":\"README.md\"}",
    },
    { type: "function_call_output", call_id: "call_valid", output: "contents" },
    { type: "future_input_item", payload: { keep: true } },
  ]);
  assert.deepEqual(captured.body.tools, body.tools);
  assert.equal(captured.body.parallel_tool_calls, true);
  assert.deepEqual(captured.body.future_field, { nested: [1, 2, 3] });
  assert.match(await response.text(), /response\.completed/);
});

test("native Responses bridges the 9codex MCP namespace for flat-tool upstreams", async (t) => {
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: response.output_item.added\n");
    res.write("data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"name\":\"mcp__9codex__image_gen\",\"arguments\":\"{}\",\"call_id\":\"call_image\"}}\n\n");
    res.end("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"name\":\"mcp__9codex__image_gen\",\"arguments\":\"{}\",\"call_id\":\"call_image\"}]}}\n\n");
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "raw/model",
      input: [{
        type: "function_call",
        namespace: "mcp__9codex",
        name: "image_gen",
        arguments: "{}",
        call_id: "call_previous",
      }],
      tools: [{
        type: "namespace",
        name: "mcp__9codex",
        tools: [{
          type: "function",
          name: "image_gen",
          description: "Generate an image.",
          parameters: { type: "object", properties: {} },
        }],
      }],
    }),
  });

  assert.equal(capturedBody.tools[0].type, "function");
  assert.equal(capturedBody.tools[0].name, "mcp__9codex__image_gen");
  assert.equal(capturedBody.input[0].namespace, undefined);
  assert.equal(capturedBody.input[0].name, "mcp__9codex__image_gen");
  const output = await response.text();
  assert.match(output, /"namespace":"mcp__9codex"/);
  assert.match(output, /"name":"image_gen"/);
  assert.doesNotMatch(output, /"name":"mcp__9codex__image_gen"/);
});

test("gateway forwards Responses request bodies larger than 64 MiB", async (t) => {
  let capturedLength;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedLength = Buffer.concat(chunks).length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const body = JSON.stringify({
    model: "raw/model",
    input: "x".repeat(64 * 1024 * 1024),
    stream: false,
  });

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.ok(capturedLength > 64 * 1024 * 1024);
});

test("native Responses routing forces priority for GPT without changing reasoning output controls", async (t) => {
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  config.upstream.default_model = "OpenAI/GPT-5.6-SOL";
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "OpenAI/GPT-5.6-SOL",
      service_tier: "default",
      reasoning: { effort: "high", summary: "detailed" },
      text: { verbosity: "high" },
      input: "hello",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(capturedBody.model, "OpenAI/GPT-5.6-SOL");
  assert.equal(capturedBody.service_tier, "priority");
  assert.deepEqual(capturedBody.reasoning, { effort: "high", summary: "detailed" });
  assert.deepEqual(capturedBody.text, { verbosity: "high" });
});

test("original GPT catalog model forces priority without a Fast alias", async (t) => {
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  config.upstream.default_model = "cx/gpt-5.6-sol";
  const active = await reconcileModelState(paths, config, {
    authoritativeModels: [{
      id: "cx/gpt-5.6-sol",
      protocol: "responses_native",
      context_window: 1_050_000,
      capabilities: { streaming: true, tools: true },
    }],
  });
  assert.deepEqual(active.built.models.map((model) => model.slug), ["cx/gpt-5.6-sol"]);
  const gateway = createGateway(active.config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "cx/gpt-5.6-sol",
      input: "hello",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(capturedBody.model, "cx/gpt-5.6-sol");
  assert.equal(capturedBody.service_tier, "priority");
});

test("native Responses streams the first upstream bytes before completion", async (t) => {
  let releaseUpstream;
  const upstreamReleased = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: response.output_text.delta\ndata: first\n\n");
    await upstreamReleased;
    res.end("event: response.completed\ndata: done\n\n");
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => {
    releaseUpstream();
    return new Promise((resolve) => upstream.close(resolve));
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  config.upstream.default_model = "gpt-5.6-sol";
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
  });
  const reader = response.body.getReader();
  const first = await reader.read();

  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString("utf8"), /first/);
  releaseUpstream();
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.match(Buffer.from(second.value).toString("utf8"), /response\.completed/);
});

test("native Responses routing coalesces split text content before forwarding", async (t) => {
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "raw/model",
      input: [{
        type: "message",
        id: "msg_developer",
        role: "developer",
        content: [
          { type: "input_text", text: "<app-context>" },
          { type: "input_text", text: "<skills>" },
          { type: "input_text", text: "<permissions>" },
          { type: "input_text", text: "<collaboration>" },
          { type: "input_text", text: "<plugins>" },
        ],
      }],
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(capturedBody.input[0].content, [{
    type: "input_text",
    text: "<app-context><skills><permissions><collaboration><plugins>",
  }]);
});

test("gateway routes the catalog model id without rewriting it", async (t) => {
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
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer 9codex_local_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "raw/model", input: "continue old task", stream: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamModel, "raw/model");
});

test("gateway replaces unavailable historical model ids with the configured default", async (t) => {
  const upstreamModels = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
    upstreamModels.push(model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  for (const model of ["gpt-5.5", "openai/gpt-5.5", "9codex/gpt-5.5", "cx/gpt-5.5"]) {
    const response = await fetch(`${gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer 9codex_local_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: "continue old task", stream: false }),
    });
    assert.equal(response.status, 200);
  }

  assert.deepEqual(upstreamModels, ["raw/model", "raw/model", "raw/model", "raw/model"]);
});

test("rejects requests without the configured local bearer token", async (t) => {
  const upstream = http.createServer((req, res) => res.end());
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "raw/model", input: "hello" }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_local_token");
});

test("proxies image generation without forwarding text-model service tier fields", async (t) => {
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
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
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
  assert.equal(Object.hasOwn(captured.body, "service_tier"), false);
  assert.equal(captured.body.prompt, "a red panda");
  assert.equal(captured.body.size, "1024x1024");
});

test("image generation removes service tier for every image model", async (t) => {
  let capturedBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-gateway-test-"));
  const paths = resolvePaths(home);
  const config = gatewayConfig(upstreamUrl);
  config.upstream.image_model = "vendor/image-model";
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/images/generations`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", service_tier: "priority" }),
  });

  assert.equal(response.status, 200);
  assert.equal("service_tier" in capturedBody, false);
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
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "raw/model", input: "hello" }),
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
  const config = gatewayConfig(upstreamUrl);
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths);
  const gatewayUrl = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer 9codex_local_test", "content-type": "application/json" },
    body: JSON.stringify({ model: "raw/model", input: "hello" }),
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
  const config = gatewayConfig("http://127.0.0.1:1");
  await routingFixture(paths, config);
  const gateway = createGateway(config, paths, {
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
    body: JSON.stringify({ model: "raw/model", input: "hello", stream: true }),
  });
  // 上游中途断开时网关仍应优雅结束响应,而不是崩溃或挂起。
  await response.text();

  // The gateway process must still be alive and serving a fresh request.
  const probe = await fetch(`${gatewayUrl}/healthz`);
  assert.equal(probe.status, 200);
});
