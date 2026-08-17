import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { DEMAND_PROPOSAL_SCHEMA, DEMAND_SOURCE_SCHEMA } from "./demand-intake.mjs";

const IMAGE_TOOL = {
  name: "image_gen",
  description: [
    "Generate an image through the configured 9codex image model.",
    "Use this whenever the user asks to create, draw, render, or generate an image.",
    "The generated image is returned directly to Codex for display.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed description of the image to generate." },
      size: { type: "string", description: "Output size, such as auto or 1024x1024." },
      quality: { type: "string", description: "Output quality, such as auto, low, medium, or high." },
      background: { type: "string", description: "Background mode, such as auto, opaque, or transparent." },
      image_detail: { type: "string", description: "Image detail level, such as low or high." },
      output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const TEAM_TOOLS = [
  {
    name: "task_group_submit",
    description: "Submit one immutable user demand event to the persistent 9codex task group for this Codex thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        source_message_id: { type: "string" },
        content: { type: "string" },
        workspace: { type: "string" },
        title: { type: "string" },
        source: DEMAND_SOURCE_SCHEMA,
        proposal: DEMAND_PROPOSAL_SCHEMA,
      },
      required: ["content", "workspace"],
      additionalProperties: false,
    },
  },
  ...["status", "pause", "resume", "cancel"].map((action) => ({
    name: `task_group_${action}`,
    description: `${action} a persistent 9codex task group.`,
    inputSchema: {
      type: "object",
      properties: {
        task_group_id: { type: "string" },
        reason: { type: "string" },
        advanced: { type: "boolean" },
      },
      required: ["task_group_id"],
      additionalProperties: false,
    },
  })),
];

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function mimeType(format) {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function dataUrlParts(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

async function imageContent(payload, format, fetchImpl) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.images) ? payload.images : [];
  const content = [];
  for (const row of rows) {
    const inline = dataUrlParts(row?.b64_json) || dataUrlParts(row?.data);
    if (inline) {
      content.push({ type: "image", data: inline.data, mimeType: inline.mimeType });
      continue;
    }
    const base64 = row?.b64_json || row?.base64 || row?.data;
    if (typeof base64 === "string" && base64.length > 0) {
      content.push({ type: "image", data: base64, mimeType: mimeType(format) });
      continue;
    }
    if (typeof row?.url === "string" && row.url.length > 0) {
      const downloaded = await fetchImpl(row.url, { signal: AbortSignal.timeout(180_000) });
      if (!downloaded.ok) throw new Error(`generated image download failed with HTTP ${downloaded.status}`);
      content.push({
        type: "image",
        data: Buffer.from(await downloaded.arrayBuffer()).toString("base64"),
        mimeType: downloaded.headers.get("content-type")?.split(";", 1)[0] || mimeType(format),
      });
    }
  }
  return { rows, content };
}

function extensionForMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function saveImages(images, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  return images.map((image, index) => {
    const extension = extensionForMime(image.mimeType);
    const filename = `9codex-${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${index + 1}.${extension}`;
    const file = path.join(outputDir, filename);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return file;
  });
}

function markdownPath(file) {
  return path.resolve(file).replaceAll("\\", "/");
}

async function callImageTool(config, args, options) {
  if (typeof args?.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const outputFormat = args.output_format || "png";
  const body = {
    model: config.upstream.image_model,
    prompt: args.prompt.trim(),
    n: 1,
    size: args.size || "auto",
    quality: args.quality || "auto",
    background: args.background || "auto",
    image_detail: args.image_detail || "high",
    output_format: outputFormat,
  };
  const generated = await fetchImpl(
    `http://${config.local.host}:${config.local.port}/v1/images/generations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.local.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    },
  );
  const text = await generated.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`image endpoint returned invalid JSON (HTTP ${generated.status})`);
  }
  if (!generated.ok) {
    throw new Error(payload?.error?.message || `image endpoint returned HTTP ${generated.status}`);
  }
  const images = await imageContent(payload, outputFormat, fetchImpl);
  if (images.content.length === 0) throw new Error("image endpoint returned no image data");
  const outputDir = options.outputDir || path.join(os.homedir(), ".9codex", "images");
  const files = saveImages(images.content, outputDir);
  const revisedPrompt = images.rows.find((row) => row?.revised_prompt)?.revised_prompt;
  const summary = `Generated image with ${config.upstream.image_model}.${
    revisedPrompt ? ` Revised prompt: ${revisedPrompt}` : ""
  }\n${files.map((file, index) => {
    const rendered = markdownPath(file);
    return `Saved image ${index + 1}: ${rendered}\nRender it in the final response exactly as:\n![Generated image](<${rendered}>)`;
  }).join("\n")}`;
  return {
    content: [{ type: "text", text: summary }],
  };
}

async function callTeamTool(config, name, args, options) {
  if (!config.team?.enabled) throw new Error("persistent team runtime is disabled");
  const fetchImpl = options.fetchImpl || fetch;
  const base = `http://${config.team.host}:${config.team.port}`;
  const action = name.slice("task_group_".length);
  let pathname;
  let method = "GET";
  let body;
  if (action === "submit") {
    pathname = "/api/demands";
    method = "POST";
    body = args;
  } else if (action === "status") {
    pathname = `/api/task-groups/${encodeURIComponent(args.task_group_id)}${args.advanced ? "?advanced=1" : ""}`;
  } else {
    pathname = `/api/task-groups/${encodeURIComponent(args.task_group_id)}/${action}`;
    method = "POST";
    body = { actor: "user", reason: args.reason || null };
  }
  const response = await fetchImpl(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${config.team.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(action === "submit" ? 210_000 : 30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`team API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(payload?.error || `team API returned HTTP ${response.status}`);
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export async function handleMcpRequest(config, request, options = {}) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return errorResponse(request?.id ?? null, -32600, "Invalid Request");
  }
  if (request.method.startsWith("notifications/")) return null;
  if (request.method === "initialize") {
    return response(request.id, {
      protocolVersion: request.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "9codex", version: options.version || "3.0.0" },
      instructions: "Use image_gen for image creation requests and return its rendered image to the user.",
    });
  }
  if (request.method === "ping") return response(request.id, {});
  if (request.method === "tools/list") return response(request.id, { tools: [IMAGE_TOOL, ...TEAM_TOOLS] });
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (name !== IMAGE_TOOL.name && !TEAM_TOOLS.some((tool) => tool.name === name)) {
      return errorResponse(request.id, -32602, `Unknown tool: ${request.params?.name || ""}`);
    }
    try {
      const args = { ...(request.params?.arguments || {}) };
      if (name === "task_group_submit" && !args.source_message_id) {
        args.source_message_id = `mcp:${crypto.createHash("sha256").update(
          `${request.id ?? ""}\0${args.thread_id || ""}\0${args.content || ""}`,
        ).digest("hex")}`;
      }
      return response(
        request.id,
        name === IMAGE_TOOL.name
          ? await callImageTool(config, args, options)
          : await callTeamTool(config, name, args, options),
      );
    } catch (error) {
      const operation = name === IMAGE_TOOL.name ? "image generation" : "task group request";
      return response(request.id, {
        content: [{ type: "text", text: `9codex ${operation} failed: ${error.message}` }],
        isError: true,
      });
    }
  }
  return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
}

export async function runMcpServer(config, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error"))}\n`);
      continue;
    }
    let result;
    try {
      result = await handleMcpRequest(config, request, options);
    } catch (error) {
      result = errorResponse(request.id ?? null, -32603, error.message);
    }
    if (result) output.write(`${JSON.stringify(result)}\n`);
  }
}
