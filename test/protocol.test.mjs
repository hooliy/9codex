import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCompatibilityProfile,
  normalizeResponsesRequest,
  sanitizeResponsesOutput,
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

test("drops a tool call pair when its output contains unsupported image content", () => {
  const result = normalizeResponsesRequest({
    input: [
      {
        type: "function_call",
        call_id: "call_image",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
      },
      { role: "user", content: "continue" },
    ],
  });

  assert.deepEqual(result.input, [{ role: "user", content: "continue" }]);
});

test("drops historical function calls whose output is missing", () => {
  const result = normalizeResponsesRequest({
    input: [
      {
        type: "function_call",
        call_id: "call_missing",
        name: "view_image",
        arguments: "{}",
      },
      { role: "user", content: "continue" },
    ],
  });

  assert.deepEqual(result.input, [{ role: "user", content: "continue" }]);
});

test("flattens textual tool output arrays", () => {
  const result = normalizeResponsesRequest({
    input: [
      {
        type: "function_call",
        call_id: "call_text",
        name: "read_file",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_text",
        output: [
          { type: "input_text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ],
  });

  assert.equal(result.input[1].output, "onetwo");
});

test("preserves parallel textual tool output across interleaved messages", () => {
  const result = normalizeResponsesRequest({
    input: [
      {
        type: "function_call",
        call_id: "call_image_1",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_image_2",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_exec",
        name: "exec_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_image_1",
        output: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
      },
      {
        role: "developer",
        content: "<image_resize_notice>resized</image_resize_notice>",
      },
      {
        type: "function_call_output",
        call_id: "call_image_2",
        output: [{ type: "input_image", image_url: "data:image/png;base64,def" }],
      },
      {
        type: "function_call_output",
        call_id: "call_exec",
        output: "command output",
      },
      { role: "user", content: "continue" },
    ],
  });

  assert.deepEqual(result.input, [
    {
      type: "function_call",
      call_id: "call_exec",
      name: "exec_command",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_exec",
      output: "command output",
    },
    { role: "user", content: "continue" },
  ]);
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

test("removes model-controlled budgets from create_goal definitions and history", () => {
  const result = normalizeResponsesRequest({
    input: [{
      type: "function_call",
      name: "create_goal",
      call_id: "call_goal",
      arguments: "{\"objective\":\"完成任务\",\"token_budget\":100000}",
    }, {
      type: "function_call_output",
      call_id: "call_goal",
      output: "created",
    }],
    tools: [{
      type: "function",
      name: "create_goal",
      description: "Create a goal.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string" },
          token_budget: { type: "integer" },
        },
        required: ["objective", "token_budget"],
      },
    }, {
      type: "function",
      name: "other_tool",
      parameters: {
        type: "object",
        properties: { token_budget: { type: "integer" } },
      },
    }],
  });

  assert.equal(
    result.input[0].arguments,
    "{\"objective\":\"完成任务\"}",
  );
  assert.equal("token_budget" in result.tools[0].parameters.properties, false);
  assert.deepEqual(result.tools[0].parameters.required, ["objective"]);
  assert.match(result.tools[0].description, /Never include token_budget/);
  assert.deepEqual(
    result.tools[1].parameters.properties,
    { token_budget: { type: "integer" } },
  );
});

test("removes token_budget only from valid create_goal output arguments", () => {
  const payload = {
    output: [{
      type: "function_call",
      name: "create_goal",
      arguments: "{\"objective\":\"完成任务\",\"token_budget\":100000}",
    }, {
      type: "function_call",
      name: "other_tool",
      arguments: "{\"token_budget\":100000}",
    }, {
      type: "function_call",
      name: "create_goal",
      arguments: "{\"objective\":",
    }],
  };

  sanitizeResponsesOutput(payload);

  assert.equal(payload.output[0].arguments, "{\"objective\":\"完成任务\"}");
  assert.equal(payload.output[1].arguments, "{\"token_budget\":100000}");
  assert.equal(payload.output[2].arguments, "{\"objective\":");
});
