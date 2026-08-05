import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatResponseTranslator,
  applyCompatibilityProfile,
  responsesToChatRequest,
} from "../lib/protocol.mjs";

test("converts Responses instructions, messages, tools, and tool results to Chat", () => {
  const result = responsesToChatRequest({
    model: "upstream-model",
    instructions: "You are Codex.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Fix it" }] },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "apply_patch",
        arguments: "{\"patch\":\"x\"}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [{
      type: "function",
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { patch: { type: "string" } } },
      strict: true,
    }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    max_output_tokens: 2048,
    stream: true,
    metadata: { preserve: "outside-chat" },
  });

  assert.deepEqual(result.messages, [
    { role: "system", content: "You are Codex." },
    { role: "user", content: "Fix it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "apply_patch", arguments: "{\"patch\":\"x\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "done" },
  ]);
  assert.deepEqual(result.tools[0], {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a patch",
      parameters: { type: "object", properties: { patch: { type: "string" } } },
      strict: true,
    },
  });
  assert.equal(result.max_completion_tokens, 2048);
  assert.equal(result.parallel_tool_calls, true);
  assert.equal("metadata" in result, false);
  assert.equal("stream_options" in result, false);
});

test("drops orphaned function call outputs instead of creating invalid Chat tool messages", () => {
  const result = responsesToChatRequest({
    model: "upstream-model",
    input: [
      { role: "user", content: "Continue" },
      { type: "function_call_output", call_id: "missing_call", output: "stale result" },
    ],
    stream: true,
  });

  assert.deepEqual(result.messages, [
    { role: "user", content: "Continue" },
  ]);
});

test("drops function calls and outputs whose tool name is empty", () => {
  const result = responsesToChatRequest({
    model: "upstream-model",
    input: [
      {
        type: "function_call",
        id: "fc_empty",
        call_id: "call_empty",
        name: "",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_empty", output: "ignored" },
    ],
    stream: true,
  });

  assert.deepEqual(result.messages, []);
});

test("groups parallel function calls before their tool outputs", () => {
  const result = responsesToChatRequest({
    model: "upstream-model",
    input: [
      { type: "function_call", call_id: "call_1", name: "first", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "second", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "one" },
      { type: "function_call_output", call_id: "call_2", output: "two" },
    ],
  });

  assert.deepEqual(result.messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "first", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "second", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "one" },
    { role: "tool", tool_call_id: "call_2", content: "two" },
  ]);
});

test("adds Chat stream usage options only when the model profile explicitly supports them", () => {
  const result = responsesToChatRequest({
    model: "upstream-model",
    input: "hello",
    stream: true,
  }, { chat_stream_options_include_usage: true });

  assert.deepEqual(result.stream_options, { include_usage: true });
});

test("applies only explicit compatibility field rules and preserves unknown data", () => {
  const input = {
    model: "model-a",
    reasoning: { effort: "high" },
    service_tier: "priority",
    future_field: { nested: [1, 2, 3] },
  };
  const result = applyCompatibilityProfile(input, {
    strip_request_fields: ["service_tier"],
    rename_request_fields: { reasoning: "reasoning_config" },
  });

  assert.equal("service_tier" in result, false);
  assert.deepEqual(result.reasoning_config, { effort: "high" });
  assert.deepEqual(result.future_field, { nested: [1, 2, 3] });
});

test("rebuilds text and tool Chat deltas into ordered Responses events", () => {
  const translator = new ChatResponseTranslator();
  const events = [
    ...translator.push({ id: "chat_1", created: 10, model: "model-a", choices: [{ delta: { content: "Hello " } }] }),
    ...translator.push({ id: "chat_1", created: 10, model: "model-a", choices: [{ delta: { content: "world" } }] }),
    ...translator.push({ id: "chat_1", created: 10, model: "model-a", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "apply_patch", arguments: "{\"patch\":" } }] } }] }),
    ...translator.push({ id: "chat_1", created: 10, model: "model-a", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }),
  ];

  assert.equal(events[0].type, "response.created");
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
    ["Hello ", "world"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta),
    ["{\"patch\":", "\"x\"}"],
  );
  const toolDone = events.find((event) => event.type === "response.output_item.done" && event.item.type === "function_call");
  assert.equal(toolDone.item.name, "apply_patch");
  assert.equal(toolDone.item.arguments, "{\"patch\":\"x\"}");
  const completed = events.at(-1);
  assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.usage.total_tokens, 12);
});

test("does not emit a function call with an empty name", () => {
  const translator = new ChatResponseTranslator();
  const events = [
    ...translator.push({
      id: "chat_2",
      model: "model-a",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_empty",
            function: { arguments: "{\"x\":1}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
  ];

  assert.equal(events.some((event) => event.item?.name === ""), false);
  assert.equal(events.some((event) => event.name === ""), false);
  assert.deepEqual(events.at(-1).response.output, []);
});

test("buffers tool arguments until a valid tool name arrives", () => {
  const translator = new ChatResponseTranslator();
  const first = translator.push({
    id: "chat_3",
    model: "model-a",
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_late_name",
          function: { arguments: "{\"path\":" },
        }],
      },
    }],
  });
  const second = translator.push({
    id: "chat_3",
    model: "model-a",
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { name: "read_file", arguments: "\"x\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  assert.equal(first.some((event) => event.type === "response.output_item.added"), false);
  assert.equal(
    second.find((event) => event.type === "response.output_item.added").item.name,
    "read_file",
  );
  assert.deepEqual(
    second
      .filter((event) => event.type === "response.function_call_arguments.delta")
      .map((event) => event.delta),
    ["{\"path\":", "\"x\"}"],
  );
});
