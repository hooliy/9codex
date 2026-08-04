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

function inputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      continue;
    }
    if (item?.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "" },
        }],
      });
      continue;
    }
    if (typeof item?.role === "string") {
      messages.push({ role: item.role, content: textFromContent(item.content) });
    }
  }
  return messages;
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
    this.text = "";
    this.tools = new Map();
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
        events.push({ type: "response.output_item.added", output_index: 0, item: structuredClone(this.message) });
        events.push({
          type: "response.content_part.added",
          item_id: this.message.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      this.text += delta.content;
      events.push({
        type: "response.output_text.delta",
        item_id: this.message.id,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const toolDelta of delta.tool_calls || []) {
      const index = Number(toolDelta.index) || 0;
      let tool = this.tools.get(index);
      if (!tool) {
        tool = {
          id: `fc_${toolDelta.id || `${chunk.id || "chat"}_${index}`}`,
          type: "function_call",
          status: "in_progress",
          call_id: toolDelta.id || `call_${index}`,
          name: toolDelta.function?.name || "",
          arguments: "",
        };
        this.tools.set(index, tool);
        events.push({
          type: "response.output_item.added",
          output_index: (this.message ? 1 : 0) + index,
          item: structuredClone(tool),
        });
      }
      if (toolDelta.function?.name) tool.name = toolDelta.function.name;
      if (typeof toolDelta.function?.arguments === "string") {
        tool.arguments += toolDelta.function.arguments;
        events.push({
          type: "response.function_call_arguments.delta",
          item_id: tool.id,
          output_index: (this.message ? 1 : 0) + index,
          delta: toolDelta.function.arguments,
        });
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
        output_index: 0,
        content_index: 0,
        text: this.text,
      });
      events.push({
        type: "response.content_part.done",
        item_id: this.message.id,
        output_index: 0,
        content_index: 0,
        part: doneMessage.content[0],
      });
      events.push({ type: "response.output_item.done", output_index: 0, item: doneMessage });
      output.push(doneMessage);
    }
    for (const [index, tool] of this.tools) {
      const outputIndex = (this.message ? 1 : 0) + index;
      const doneTool = { ...tool, status: "completed" };
      events.push({
        type: "response.function_call_arguments.done",
        item_id: tool.id,
        output_index: outputIndex,
        name: tool.name,
        arguments: tool.arguments,
      });
      events.push({ type: "response.output_item.done", output_index: outputIndex, item: doneTool });
      output.push(doneTool);
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
      output,
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
