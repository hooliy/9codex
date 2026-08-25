import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCompatibilityProfile,
  normalizeResponsesRequest,
} from "../lib/protocol.mjs";

test("removes invalid historical message IDs before forwarding Responses input", () => {
  const result = normalizeResponsesRequest({
    model: "upstream-model",
    input: [
      { type: "message", id: "item_legacy", role: "assistant", content: [] },
      { type: "message", id: "", role: "assistant", content: [] },
      { type: "message", id: "msg_valid", role: "user", content: [] },
    ],
  });

  assert.deepEqual(result.input, [
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", id: "msg_valid", role: "user", content: [] },
  ]);
});

test("removes historical reasoning while preserving valid Responses tool calls", () => {
  const result = normalizeResponsesRequest({
    model: "upstream-model",
    input: [
      { role: "user", content: "Continue" },
      { type: "reasoning", encrypted_content: "legacy" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
      { role: "assistant", content: "Done" },
    ],
  });

  assert.deepEqual(result.input, [
    { role: "user", content: "Continue" },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "{\"path\":\"README.md\"}",
    },
    { type: "function_call_output", call_id: "call_1", output: "contents" },
    { role: "assistant", content: "Done" },
  ]);
});

test("flattens Responses text arrays without changing tool definitions", () => {
  const tools = [
    { type: "custom", name: "apply_patch", format: { type: "grammar" } },
    { type: "namespace", name: "multi_agent_v1", tools: [] },
    { type: "namespace", name: "mcp__9codex", tools: [] },
    { type: "web_search", external_web_access: true },
  ];
  const result = normalizeResponsesRequest({
    model: "upstream-model",
    input: [{
      role: "developer",
      content: [
        { type: "input_text", text: "one" },
        { type: "input_text", text: "two" },
      ],
    }],
    tools,
  });

  assert.equal(result.input[0].content, "onetwo");
  assert.deepEqual(result.tools, tools);
});

test("applies only explicit Responses compatibility field rules", () => {
  const result = applyCompatibilityProfile({
    model: "model-a",
    reasoning: { effort: "high" },
    service_tier: "priority",
    future_field: { nested: [1, 2, 3] },
  }, {
    strip_request_fields: ["service_tier"],
    rename_request_fields: { reasoning: "reasoning_config" },
  });

  assert.equal("service_tier" in result, false);
  assert.deepEqual(result.reasoning_config, { effort: "high" });
  assert.deepEqual(result.future_field, { nested: [1, 2, 3] });
});
