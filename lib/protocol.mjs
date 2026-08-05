function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const mapped = content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (["input_text", "output_text", "text"].includes(part?.type)) {
      return [{ type: "text", text: part.text || "" }];
    }
    if (part?.type === "input_image") {
      const url = part.image_url || part.url;
      return url ? [{ type: "image_url", image_url: { url } }] : [];
    }
    return [];
  });
  if (mapped.every((part) => part.type === "text")) return mapped.map((part) => part.text).join("");
  return mapped;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeResponsesInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return [];
  const normalized = [];
  const pendingToolCalls = new Set();

  for (const item of input) {
    if (item?.type === "function_call") {
      const callId = item.call_id || item.id;
      if (!nonEmptyString(item.name) || !nonEmptyString(callId)) continue;
      normalized.push({
        ...item,
        name: item.name.trim(),
        call_id: callId,
      });
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
      normalized.push(item);
      continue;
    }
    pendingToolCalls.clear();
    normalized.push(item);
  }
  return normalized;
}

function inputToMessages(input) {
  const normalized = normalizeResponsesInput(input);
  if (typeof normalized === "string") return [{ role: "user", content: normalized }];
  const messages = [];
  let previousType = null;
  for (const item of normalized) {
    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      previousType = item.type;
      continue;
    }
    if (item?.type === "function_call") {
      const callId = item.call_id || item.id;
      const previous = messages.at(-1);
      if (previousType === "function_call" && previous?.role === "assistant") {
        previous.tool_calls.push({
          id: callId,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "" },
        });
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: callId,
            type: "function",
            function: { name: item.name, arguments: item.arguments || "" },
          }],
        });
      }
      previousType = item.type;
      continue;
    }
    if (typeof item?.role === "string") {
      messages.push({ role: item.role, content: textFromContent(item.content) });
      previousType = "message";
      continue;
    }
    previousType = "other";
  }
  return messages;
}

export function normalizeResponsesRequest(request) {
  const result = structuredClone(request);
  if (Object.hasOwn(result, "input")) result.input = normalizeResponsesInput(result.input);
  return result;
}

function convertTool(tool) {
  if (tool?.type !== "function") return null;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    },
  };
}

export function responsesToChatRequest(request, compatibility = {}) {
  const messages = [];
  if (typeof request.instructions === "string" && request.instructions.length > 0) {
    messages.push({ role: "system", content: request.instructions });
  }
  messages.push(...inputToMessages(request.input));
  const tools = Array.isArray(request.tools) ? request.tools.map(convertTool).filter(Boolean) : [];
  return {
    model: request.model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.tool_choice !== undefined ? { tool_choice: request.tool_choice } : {}),
    ...(request.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: Boolean(request.parallel_tool_calls) }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.max_output_tokens !== undefined
      ? { max_completion_tokens: request.max_output_tokens }
      : {}),
    stream: request.stream !== false,
    ...(request.stream !== false && compatibility.chat_stream_options_include_usage === true
      ? { stream_options: { include_usage: true } }
      : {}),
  };
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

function responseBase(chunk, status = "in_progress") {
  return {
    id: `resp_${chunk.id || "chat"}`,
    object: "response",
    created_at: Number(chunk.created) || Math.floor(Date.now() / 1000),
    status,
    model: chunk.model,
    output: [],
  };
}

export class ChatResponseTranslator {
  constructor() {
    this.created = false;
    this.response = null;
    this.message = null;
    this.messageOutputIndex = null;
    this.text = "";
    this.tools = new Map();
    this.nextOutputIndex = 0;
    this.completed = false;
  }

  push(chunk) {
    if (this.completed) return [];
    const events = [];
    if (!this.created) {
      this.response = responseBase(chunk);
      events.push({ type: "response.created", response: structuredClone(this.response) });
      this.created = true;
    }
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!this.message) {
        this.message = {
          id: `msg_${chunk.id || "chat"}`,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        };
        this.messageOutputIndex = this.nextOutputIndex++;
        events.push({
          type: "response.output_item.added",
          output_index: this.messageOutputIndex,
          item: structuredClone(this.message),
        });
        events.push({
          type: "response.content_part.added",
          item_id: this.message.id,
          output_index: this.messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      this.text += delta.content;
      events.push({
        type: "response.output_text.delta",
        item_id: this.message.id,
        output_index: this.messageOutputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const [fallbackIndex, toolDelta] of (delta.tool_calls || []).entries()) {
      const index = Number.isInteger(Number(toolDelta.index)) ? Number(toolDelta.index) : fallbackIndex;
      let tool = this.tools.get(index);
      if (!tool) {
        tool = {
          id: `fc_${toolDelta.id || `${chunk.id || "chat"}_${index}`}`,
          type: "function_call",
          status: "in_progress",
          call_id: toolDelta.id || `call_${index}`,
          name: null,
          arguments: "",
          pendingArguments: [],
          emitted: false,
          outputIndex: null,
        };
        this.tools.set(index, tool);
      }
      if (nonEmptyString(toolDelta.id)) tool.call_id = toolDelta.id;
      if (nonEmptyString(toolDelta.function?.name)) tool.name = toolDelta.function.name.trim();
      if (typeof toolDelta.function?.arguments === "string") {
        tool.arguments += toolDelta.function.arguments;
        if (tool.emitted) {
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: tool.id,
            output_index: tool.outputIndex,
            delta: toolDelta.function.arguments,
          });
        } else {
          tool.pendingArguments.push(toolDelta.function.arguments);
        }
      }
      if (!tool.emitted && nonEmptyString(tool.name)) {
        tool.emitted = true;
        tool.outputIndex = this.nextOutputIndex++;
        events.push({
          type: "response.output_item.added",
          output_index: tool.outputIndex,
          item: structuredClone({
            id: tool.id,
            type: tool.type,
            status: tool.status,
            call_id: tool.call_id,
            name: tool.name,
            arguments: "",
          }),
        });
        for (const argumentDelta of tool.pendingArguments) {
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: tool.id,
            output_index: tool.outputIndex,
            delta: argumentDelta,
          });
        }
        tool.pendingArguments = [];
      }
    }
    if (choice.finish_reason) events.push(...this.finish(chunk));
    return events;
  }

  finish(chunk) {
    if (this.completed) return [];
    const events = [];
    const output = [];
    if (this.message) {
      const doneMessage = {
        ...this.message,
        status: "completed",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      events.push({
        type: "response.output_text.done",
        item_id: this.message.id,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.text,
      });
      events.push({
        type: "response.content_part.done",
        item_id: this.message.id,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: doneMessage.content[0],
      });
      events.push({
        type: "response.output_item.done",
        output_index: this.messageOutputIndex,
        item: doneMessage,
      });
      output.push({ outputIndex: this.messageOutputIndex, item: doneMessage });
    }
    for (const [index, tool] of this.tools) {
      if (!tool.emitted || !nonEmptyString(tool.name)) continue;
      const outputIndex = tool.outputIndex;
      const doneTool = { ...tool, status: "completed" };
      delete doneTool.pendingArguments;
      delete doneTool.emitted;
      delete doneTool.outputIndex;
      events.push({
        type: "response.function_call_arguments.done",
        item_id: tool.id,
        output_index: outputIndex,
        name: tool.name,
        arguments: tool.arguments,
      });
      events.push({ type: "response.output_item.done", output_index: outputIndex, item: doneTool });
      output.push({ outputIndex, item: doneTool });
    }
    const usage = chunk.usage
      ? {
          input_tokens: Number(chunk.usage.prompt_tokens) || 0,
          output_tokens: Number(chunk.usage.completion_tokens) || 0,
          total_tokens: Number(chunk.usage.total_tokens) || 0,
        }
      : undefined;
    this.response = {
      ...this.response,
      status: "completed",
      output: output.sort((a, b) => a.outputIndex - b.outputIndex).map(({ item }) => item),
      ...(usage ? { usage } : {}),
    };
    events.push({ type: "response.completed", response: structuredClone(this.response) });
    this.completed = true;
    return events;
  }
}

export function formatResponseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
