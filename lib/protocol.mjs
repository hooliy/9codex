function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function coalesceTextContent(content) {
  if (!Array.isArray(content)) return content;
  const result = [];
  for (const part of content) {
    const previous = result.at(-1);
    if (
      ["input_text", "output_text", "text"].includes(part?.type)
      && typeof part.text === "string"
      && previous?.type === part.type
      && typeof previous.text === "string"
    ) {
      previous.text += part.text;
    } else {
      result.push(structuredClone(part));
    }
  }
  if (
    result.length > 0
    && result.every((part) => (
      ["input_text", "output_text", "text"].includes(part?.type)
      && typeof part.text === "string"
    ))
  ) {
    return result.map((part) => part.text).join("");
  }
  return result;
}

function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return null;
  const text = output.map((part) => (
    ["input_text", "output_text", "text"].includes(part?.type)
    && typeof part.text === "string"
      ? part.text
      : null
  ));
  return text.every((part) => part !== null) ? text.join("") : null;
}

function normalizeResponsesInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return [];
  const normalized = [];
  const usableOutputs = new Map();
  const usableCalls = new Set();
  for (const item of input) {
    if (item?.type !== "function_call_output" || !nonEmptyString(item.call_id)) continue;
    const output = normalizeToolOutput(item.output);
    if (output !== null) usableOutputs.set(item.call_id, output);
  }
  for (const item of input) {
    if (item?.type !== "function_call") continue;
    const callId = item.call_id || item.id;
    if (
      nonEmptyString(item.name)
      && nonEmptyString(callId)
      && usableOutputs.has(callId)
    ) usableCalls.add(callId);
  }
  for (const item of input) {
    if (item?.type === "reasoning") continue;
    if (item?.type === "function_call") {
      const callId = item.call_id || item.id;
      if (
        !nonEmptyString(item.name)
        || !nonEmptyString(callId)
        || !usableOutputs.has(callId)
      ) continue;
      normalized.push({ ...item, name: item.name.trim(), call_id: callId });
      continue;
    }
    if (item?.type === "function_call_output") {
      if (!nonEmptyString(item.call_id) || !usableCalls.has(item.call_id)) continue;
      normalized.push({ ...item, output: usableOutputs.get(item.call_id) });
      continue;
    }
    if (typeof item?.role === "string") {
      const message = { ...item };
      if (Object.hasOwn(message, "id") && !message.id?.startsWith?.("msg_")) delete message.id;
      if (Object.hasOwn(message, "content")) message.content = coalesceTextContent(message.content);
      if (
        message.role === "developer"
        && typeof message.content === "string"
        && /^<image_resize_notice>[\s\S]*<\/image_resize_notice>$/.test(message.content.trim())
      ) continue;
      normalized.push(message);
      continue;
    }
    normalized.push(item);
  }
  return normalized;
}

export function normalizeResponsesRequest(request) {
  const result = structuredClone(request);
  if (Object.hasOwn(result, "input")) result.input = normalizeResponsesInput(result.input);
  return result;
}

export function applyCompatibilityProfile(request, profile = {}) {
  const result = structuredClone(request);
  for (const field of profile.strip_request_fields || []) delete result[field];
  for (const [from, to] of Object.entries(profile.rename_request_fields || {})) {
    if (Object.hasOwn(result, from)) {
      result[to] = result[from];
      delete result[from];
    }
  }
  return result;
}
