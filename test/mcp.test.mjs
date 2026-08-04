import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleMcpRequest } from "../lib/mcp.mjs";

function config() {
  return {
    local: { host: "127.0.0.1", port: 10101, token: "9codex_local_test" },
    upstream: { image_model: "cx/gpt-5.5-image" },
  };
}

test("advertises a native image generation tool to Codex", async () => {
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });

  assert.equal(response.id, 1);
  assert.deepEqual(response.result.tools.map((tool) => tool.name), ["image_gen"]);
  assert.equal(response.result.tools[0].inputSchema.required.includes("prompt"), true);
});

test("saves generated image bytes from the authenticated local gateway for desktop rendering", async () => {
  let captured;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-images-test-"));
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 2,
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
  assert.equal(captured.body.prompt, "a red panda");
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  assert.match(response.result.content[0].text, /Generated image with cx\/gpt-5\.5-image\./);
  assert.match(response.result.content[0].text, /Revised prompt: A red panda/);
  assert.match(response.result.content[0].text, /!\[Generated image\]\(<.*\.png>\)/);
  const files = fs.readdirSync(outputDir);
  assert.equal(files.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(outputDir, files[0])), Buffer.from("image"));
});
