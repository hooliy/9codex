import { contextWindowForBudget, normalizeContextWindowMetadata } from "./model-metadata.mjs";

const DEFAULT_CHARS_PER_TOKEN = 4;

function json(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Cannot estimate tokens for an unserializable value: ${error.message}`);
  }
}

/** Conservative, dependency-free estimate for auditable preflight accounting. */
export function estimateTokens(value, options = {}) {
  if (value === undefined || value === null || value === "") return 0;
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  if (typeof charsPerToken !== "number" || !Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new TypeError("charsPerToken must be a positive finite number");
  }
  const text = typeof value === "string" ? value : json(value);
  return Math.ceil(Buffer.byteLength(text, "utf8") / charsPerToken);
}

function positiveInteger(value, name, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function addEstimate(result, category, value, estimate) {
  if (value === undefined || value === null || value === "") return;
  const tokens = estimate(value);
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new TypeError("token estimator must return a non-negative safe integer");
  }
  result[category] += tokens;
}

function isToolOutput(item) {
  return item?.type === "function_call_output"
    || item?.type === "tool_result"
    || item?.role === "tool";
}

function isToolCall(item) {
  return item?.type === "function_call"
    || item?.type === "tool_call";
}

function itemBreakdown(input, estimate) {
  const inputItems = Array.isArray(input) ? input : input === undefined ? [] : [input];
  const result = { history: 0, tool_calls: 0, tool_outputs: 0 };
  for (const item of inputItems) {
    if (isToolCall(item)) {
      addEstimate(result, "tool_calls", item, estimate);
      continue;
    }
    if (isToolOutput(item)) {
      addEstimate(result, "tool_outputs", item, estimate);
      continue;
    }

    // Chat Completions represents calls inside an assistant message. Count the
    // message envelope/content as history and the calls in their own auditable
    // category rather than hiding them in a single aggregate.
    if (Array.isArray(item?.tool_calls)) {
      const { tool_calls, ...message } = item;
      addEstimate(result, "history", message, estimate);
      addEstimate(result, "tool_calls", tool_calls, estimate);
      continue;
    }
    if (item?.function_call !== undefined) {
      const { function_call, ...message } = item;
      addEstimate(result, "history", message, estimate);
      addEstimate(result, "tool_calls", function_call, estimate);
      continue;
    }
    addEstimate(result, "history", item, estimate);
  }
  return result;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

/**
 * Calculate a request's preflight context budget.  The result is intentionally
 * serializable and includes every counted category so callers can retain it as
 * evidence alongside an attempted request.
 */
export function calculateTokenBudget(request = {}, model = {}, options = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("request must be an object");
  }
  const estimate = options.estimateTokens || ((value) => estimateTokens(value, options));
  if (typeof estimate !== "function") throw new TypeError("estimateTokens must be a function");

  const primaryInput = firstDefined(request.input, request.history, request.messages);
  const fromInput = itemBreakdown(primaryInput, estimate);
  const explicitToolCalls = request.tool_calls ?? request.function_calls;
  const explicitToolOutputs = request.tool_outputs ?? request.function_call_outputs;
  const components = {
    instructions: 0,
    history: fromInput.history,
    tool_definitions: 0,
    tool_calls: fromInput.tool_calls,
    tool_outputs: fromInput.tool_outputs,
  };
  addEstimate(
    components,
    "instructions",
    firstDefined(request.instructions, request.system, request.developer),
    estimate,
  );
  addEstimate(components, "tool_definitions", request.tools, estimate);
  addEstimate(components, "tool_calls", explicitToolCalls, estimate);
  addEstimate(components, "tool_outputs", explicitToolOutputs, estimate);
  components.input = Object.values(components).reduce((total, value) => total + value, 0);

  const modelMaxOutput = positiveInteger(
    firstDefined(model.max_output_tokens, model.max_completion_tokens),
    "model.max_output_tokens",
    0,
  );
  const requestedOutput = positiveInteger(
    firstDefined(request.max_output_tokens, request.max_completion_tokens),
    "request.max_output_tokens",
    modelMaxOutput,
  );
  if (modelMaxOutput && requestedOutput > modelMaxOutput) {
    throw new RangeError("request.max_output_tokens exceeds model.max_output_tokens");
  }
  const reasoning = positiveInteger(
    firstDefined(
      request.reasoning_tokens,
      request.reasoning?.max_tokens,
      options.reasoningReserveTokens,
      model.reasoning_tokens,
      model.reasoning?.max_tokens,
    ),
    "reasoning token reserve",
  );
  const safety = positiveInteger(options.safetyMarginTokens, "safetyMarginTokens", 0);
  const metadata = normalizeContextWindowMetadata(model, options);
  const contextWindow = contextWindowForBudget(metadata, options);
  const reserved = requestedOutput + reasoning + safety;
  const availableInput = contextWindow === null ? null : Math.max(0, contextWindow - reserved);
  const fits = availableInput !== null && components.input <= availableInput;

  return {
    context_window: metadata,
    trusted_context_window: contextWindow,
    input_tokens: components.input,
    components,
    reservations: {
      max_output_tokens: requestedOutput,
      reasoning_tokens: reasoning,
      safety_margin_tokens: safety,
      total: reserved,
    },
    available_input_tokens: availableInput,
    total_requested_tokens: components.input + reserved,
    fits,
    reason: contextWindow === null
      ? "context_window_unknown"
      : fits ? null : "context_window_exceeded",
  };
}

export const buildTokenBudget = calculateTokenBudget;

export function assertTokenBudget(request, model, options = {}) {
  const budget = calculateTokenBudget(request, model, options);
  if (!budget.fits) {
    const error = new RangeError(
      budget.reason === "context_window_unknown"
        ? "Cannot preflight request: the model context window is unknown"
        : `Request needs ${budget.input_tokens} input tokens but only ${budget.available_input_tokens} are available`,
    );
    error.code = budget.reason === "context_window_unknown"
      ? "CONTEXT_WINDOW_UNKNOWN"
      : "CONTEXT_BUDGET_EXCEEDED";
    error.budget = budget;
    throw error;
  }
  return budget;
}
