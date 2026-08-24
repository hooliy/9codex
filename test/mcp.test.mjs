import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, saveConfigAtomic } from "../lib/config.mjs";
import { handleMcpRequest } from "../lib/mcp.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function config() {
  return {
    local: { host: "127.0.0.1", port: 10101, token: "9codex_local_test" },
    upstream: { image_model: "cx/gpt-5.5-image" },
  };
}

test("advertises only the headless image tool", async () => {
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });

  assert.deepEqual(response.result.tools.map((tool) => tool.name), ["image_gen"]);
  assert.equal(response.result.tools[0].inputSchema.required.includes("prompt"), true);
});

test("rejects removed task orchestrator tools", async () => {
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "task_group_submit", arguments: {} },
  });

  assert.equal(response.error.code, -32602);
});

test("saves generated image bytes from the authenticated local gateway", async () => {
  let captured;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-images-test-"));
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "image_gen",
      arguments: { prompt: "a red panda", size: "1024x1024", quality: "high" },
    },
  }, {
    outputDir,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A red panda" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(captured.url, "http://127.0.0.1:10101/v1/images/generations");
  assert.equal(captured.headers.authorization, "Bearer 9codex_local_test");
  assert.equal(captured.body.model, "cx/gpt-5.5-image");
  assert.match(response.result.content[0].text, /Generated image with cx\/gpt-5\.5-image\./);
  assert.deepEqual(
    fs.readFileSync(path.join(outputDir, fs.readdirSync(outputDir)[0])),
    Buffer.from("image"),
  );
});

test("CLI MCP process advertises and executes image_gen end to end", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-mcp-process-test-"));
  const paths = resolvePaths(home);
  const gateway = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const config = defaultConfig();
  config.local.port = gateway.address().port;
  config.upstream.image_model = "cx/gpt-5.5-image";
  saveConfigAtomic(paths, config);
  const child = spawn(process.execPath, [path.resolve("bin/9codex.mjs"), "mcp"], {
    env: { ...process.env, NINECODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  for (const request of [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "image_gen", arguments: { prompt: "a red panda" } },
    },
  ]) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(stderr, "");
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.find((row) => row.id === 2).result.tools.map((tool) => tool.name), [
    "image_gen",
  ]);
  assert.equal(responses.find((row) => row.id === 3).result.isError, undefined);
  assert.equal(fs.readdirSync(paths.imagesDir).length, 1);
});
