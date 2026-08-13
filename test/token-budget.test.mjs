import assert from "node:assert/strict";
import test from "node:test";

import { assertTokenBudget, calculateTokenBudget } from "../lib/token-budget.mjs";

test("budget accounts for instructions, history, tools, calls, outputs, and reservations", () => {
  const counted = [];
  const budget = calculateTokenBudget({
    instructions: "system",
    input: [
      { role: "user", content: "history" },
      { type: "function_call", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "output" },
    ],
    tools: [{ type: "function", name: "read", parameters: {} }],
    max_output_tokens: 100,
    reasoning_tokens: 50,
  }, { context_window: 1_000 }, {
    safetyMarginTokens: 25,
    estimateTokens(value) {
      counted.push(value);
      return value === undefined ? 0 : 10;
    },
  });

  assert.deepEqual(budget.components, {
    instructions: 10,
    history: 10,
    tool_definitions: 10,
    tool_calls: 10,
    tool_outputs: 10,
    input: 50,
  });
  assert.deepEqual(budget.reservations, {
    max_output_tokens: 100,
    reasoning_tokens: 50,
    safety_margin_tokens: 25,
    total: 175,
  });
  assert.equal(budget.trusted_context_window, 900);
  assert.equal(budget.available_input_tokens, 725);
  assert.equal(budget.fits, true);
  assert.equal(counted.length, 5);
});

test("unknown metadata blocks preflight instead of accepting the product fallback", () => {
  const budget = calculateTokenBudget({ input: "hello", max_output_tokens: 10 }, {});

  assert.equal(budget.trusted_context_window, null);
  assert.equal(budget.available_input_tokens, null);
  assert.equal(budget.reason, "context_window_unknown");
  assert.throws(() => assertTokenBudget({ input: "hello" }, {}), {
    code: "CONTEXT_WINDOW_UNKNOWN",
  });
});

test("uses the current model's boundary, not a fixed global threshold", () => {
  const request = { input: "x".repeat(4_000), max_output_tokens: 100 };
  const small = calculateTokenBudget(request, { context_window: 1_000 });
  const large = calculateTokenBudget(request, { context_window: 10_000 });

  assert.equal(small.fits, false);
  assert.equal(large.fits, true);
  assert.throws(() => assertTokenBudget(request, { context_window: 1_000 }), {
    code: "CONTEXT_BUDGET_EXCEEDED",
  });
});

test("enforces a declared model output limit before dispatch", () => {
  assert.throws(
    () => calculateTokenBudget({ input: "hi", max_output_tokens: 101 }, {
      context_window: 1_000,
      max_output_tokens: 100,
    }),
    /exceeds model\.max_output_tokens/,
  );
});

test("classifies Chat history tool calls and tool-role outputs separately", () => {
  const budget = calculateTokenBudget({
    messages: [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  }, { context_window: 1_000 }, {
    estimateTokens() {
      return 1;
    },
  });

  assert.equal(budget.components.history, 2);
  assert.equal(budget.components.tool_calls, 1);
  assert.equal(budget.components.tool_outputs, 1);
  assert.equal(budget.input_tokens, 4);
});

test("a measured limit can tighten but cannot enlarge the declared model budget", () => {
  const request = { input: "x".repeat(4_000) };
  const tightened = calculateTokenBudget(request, {
    context_window: 10_000,
    measured_context_window: 1_000,
  });
  const capped = calculateTokenBudget(request, {
    context_window: 1_000,
    measured_context_window: 10_000,
  });

  assert.equal(tightened.trusted_context_window, 900);
  assert.equal(capped.trusted_context_window, 900);
  assert.equal(tightened.fits, false);
  assert.equal(capped.fits, false);
});

test("rejects invalid custom token estimates instead of corrupting accounting", () => {
  assert.throws(
    () => calculateTokenBudget({ input: "hello" }, { context_window: 1_000 }, {
      estimateTokens() {
        return 0.5;
      },
    }),
    /token estimator/i,
  );
});
