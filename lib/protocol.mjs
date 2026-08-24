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
  return result;
}

function normalizeResponsesInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return [];
  const normalized = [];
  const pendingToolCalls = new Set();

  for (const item of input) {
    if (item?.type === "reasoning") continue;
    if (item?.type === "function_call") {
      const callId = item.call_id || item.id;
      if (!nonEmptyString(item.name) || !nonEmptyString(callId)) continue;
      normalized.push({ ...item, name: item.name.trim(), call_id: callId });
      pendingToolCalls.add(callId);
      continue;
    }
    if (item?.type === "function_call_output") {
      if (!nonEmptyString(item.call_id) || !pendingToolCalls.has(item.call_id)) continue;
      normalized.push(item);
      pendingToolCalls.delete(item.call_id);
      continue;
    }
    if (typeof item?.role === "string") {
      pendingToolCalls.clear();
      const message = { ...item };
      if (Object.hasOwn(message, "id") && !message.id?.startsWith?.("msg_")) delete message.id;
      if (Object.hasOwn(message, "content")) message.content = coalesceTextContent(message.content);
      normalized.push(message);
      continue;
    }
    pendingToolCalls.clear();
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
