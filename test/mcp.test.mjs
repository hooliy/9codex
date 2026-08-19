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
    team: {
      enabled: true,
      host: "127.0.0.1",
      port: 10102,
      token: "9codex_team_test",
    },
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
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "image_gen",
    "task_group_submit",
    "task_group_status",
    "task_group_pause",
    "task_group_resume",
    "task_group_cancel",
  ]);
  assert.equal(response.result.tools[0].inputSchema.required.includes("prompt"), true);
  const submit = response.result.tools.find((tool) => tool.name === "task_group_submit");
  assert.equal(submit.inputSchema.properties.source.required.includes("kind"), true);
  assert.equal(submit.inputSchema.properties.proposal.required.includes("requirements"), true);
  assert.equal(
    submit.inputSchema.properties.proposal.properties.requirements.items.properties.requirementId.anyOf[1].type,
    "null",
  );
});

test("submits immutable demand events through the authenticated team API", async () => {
  let captured;
  const source = {
    kind: "document",
    reference: "/tmp/plan.docx",
    fingerprint: "sha256:abc",
    metadata: { page: 2 },
  };
  const proposal = {
    summary: "实现登录",
    questions: [],
    requirements: [{
      key: "login",
      requirementId: null,
      title: "登录",
      normalizedRequirement: "实现登录",
      impactSummary: "新增认证",
      acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
      impactActions: [],
      workItems: [{
        key: "implementation",
        title: "实现",
        description: "实现登录",
        priority: 0,
        writeSet: ["lib/auth.mjs"],
        readSet: [],
        resourceLocks: [],
        dependencies: [],
        acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
      }],
    }],
  };
  const response = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "task_group_submit",
      arguments: {
        thread_id: "thread-1",
        source_message_id: "message-1",
        content: "实现登录",
        workspace: "/repo",
        source,
        proposal,
      },
    },
  }, {
    fetchImpl: async (url, init) => {
      captured = { url: String(url), ...init };
      return new Response(JSON.stringify({ task_group_id: "tg_1", created: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(captured.url, "http://127.0.0.1:10102/api/demands");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.authorization, "Bearer 9codex_team_test");
  const body = JSON.parse(captured.body);
  assert.equal(body.content, "实现登录");
  assert.deepEqual(body.source, source);
  assert.deepEqual(body.proposal, proposal);
  assert.match(response.result.content[0].text, /tg_1/);
});

test("derives stable demand identity from the MCP call when source identity is unavailable", async () => {
  const bodies = [];
  const request = {
    jsonrpc: "2.0",
    id: "tool-call-1",
    method: "tools/call",
    params: {
      name: "task_group_submit",
      arguments: {
        thread_id: "thread-1",
        content: "实现登录",
        workspace: "/repo",
      },
    },
  };
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ task_group_id: "tg_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await handleMcpRequest(config(), request, { fetchImpl });
  await handleMcpRequest(config(), request, { fetchImpl });

  assert.match(bodies[0].source_message_id, /^mcp:[a-f0-9]{64}$/);
  assert.equal(bodies[1].source_message_id, bodies[0].source_message_id);
});

test("reads and controls task groups without exposing the token in results", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init]);
    return new Response(JSON.stringify({ id: "tg_1", status: "paused" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  for (const name of ["task_group_status", "task_group_pause", "task_group_resume", "task_group_cancel"]) {
    const result = await handleMcpRequest(config(), {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { task_group_id: "tg_1", reason: "test" } },
    }, { fetchImpl });
    assert.doesNotMatch(JSON.stringify(result), /9codex_team_test/);
  }
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[1][1].method, "POST");
});

test("reports team tool failures as task group errors", async () => {
  const result = await handleMcpRequest(config(), {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "task_group_submit",
      arguments: { content: "实现登录", workspace: "/repo" },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      error: "active_conversation_ambiguous",
    }), { status: 409, headers: { "content-type": "application/json" } }),
  });

  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /task group request failed/);
  assert.doesNotMatch(result.result.content[0].text, /image generation failed/);
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
