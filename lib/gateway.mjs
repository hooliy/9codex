import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import zlib from "node:zlib";

import {
  ChatResponseTranslator,
  applyCompatibilityProfile,
  formatResponseEvent,
  normalizeResponsesRequest,
  responsesToChatRequest,
} from "./protocol.mjs";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function authorized(req, expected) {
  const actual = String(req.headers.authorization || "");
  const wanted = `Bearer ${expected}`;
  const a = Buffer.from(actual);
  const b = Buffer.from(wanted);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodeBody(body, encoding) {
  const normalized = String(encoding || "identity").split(",", 1)[0].trim().toLowerCase();
  if (!normalized || normalized === "identity") return body;
  if (normalized === "gzip") return zlib.gunzipSync(body);
  if (normalized === "deflate") return zlib.inflateSync(body);
  if (normalized === "zstd" && typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(body);
  }
  throw new Error(`unsupported content-encoding: ${normalized}`);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024 * 1024) throw new Error("request body exceeds 64 MiB");
    chunks.push(chunk);
  }
  const decoded = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
  return JSON.parse(decoded.toString("utf8"));
}

function loadRouting(paths) {
  const payload = JSON.parse(fs.readFileSync(paths.modelMap, "utf8"));
  return {
    aliases: payload.public_to_upstream || {},
    protocols: payload.upstream_protocols || {},
  };
}

export function routeForModel(paths, requested) {
  const routing = loadRouting(paths);
  const upstreamModel = routing.aliases[requested] || requested;
  return {
    upstreamModel,
    ...(routing.protocols[upstreamModel] || {
      protocol: "responses_native",
      capabilities: {},
      compatibility: {},
    }),
  };
}

function upstreamHeaders(upstream, requestBody) {
  return {
    "content-type": "application/json",
    accept: requestBody.stream === false ? "application/json" : "text/event-stream",
    authorization: `Bearer ${upstream.api_key}`,
  };
}

function imageHeaders(upstream) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${upstream.api_key}`,
  };
}

function copyResponseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return headers;
}

async function fetchNative(req, config, route, body, fetchImpl) {
  const normalized = normalizeResponsesRequest(body);
  const repaired = route.protocol === "responses_compat"
    ? applyCompatibilityProfile(normalized, route.compatibility)
    : normalized;
  repaired.model = route.upstreamModel;
  return fetchImpl(new URL(req.url, `${config.upstream.base_url.replace(/\/$/, "")}/`), {
    method: req.method,
    headers: upstreamHeaders(config.upstream, repaired),
    body: JSON.stringify(repaired),
  });
}

function embeddedErrorMessage(message) {
  if (typeof message !== "string") return null;
  const start = message.indexOf("{");
  if (start === -1) return message;
  for (let end = message.lastIndexOf("}"); end > start; end = message.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(message.slice(start, end + 1));
      const nested = parsed?.error?.message;
      if (typeof nested === "string" && nested.length > 0) return embeddedErrorMessage(nested);
    } catch {}
  }
  return message;
}

function longTermQuotaReason(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  const reason = embeddedErrorMessage(payload?.error?.message);
  if (!reason) return null;
  const datedChineseLimit = reason.match(
    /(?:已)?达到\s*\d+\s*天使用上限[，,]?\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*后可继续使用/,
  );
  if (datedChineseLimit) return `${datedChineseLimit[0]}。`;
  const longTermQuota = [
    /(?:已)?达到\s*\d+\s*天使用上限/,
    /\d{4}-\d{2}-\d{2}[^。]*(?:后可继续使用|后重置)/,
    /(?:配额|额度)[^。]*(?:耗尽|不足|用完|上限)/,
    /(?:insufficient[_ ]quota|quota[_ ](?:exceeded|exhausted)|(?:daily|weekly|monthly)[_ ](?:usage[_ ])?limit)/i,
  ];
  return longTermQuota.some((pattern) => pattern.test(reason)) ? reason : null;
}

async function pipeUpstreamResponse(res, response) {
  if (response.status === 429) {
    const body = Buffer.from(await response.arrayBuffer());
    const quotaReason = longTermQuotaReason(body);
    if (quotaReason) {
      sendJson(res, 400, {
        error: {
          code: "upstream_quota_exhausted",
          message: quotaReason,
        },
      });
      return;
    }
    res.writeHead(response.status, copyResponseHeaders(response));
    res.end(body);
    return;
  }
  res.writeHead(response.status, copyResponseHeaders(response));
  if (response.body) {
    const stream = Readable.fromWeb(response.body);
    stream.on("error", () => {
      try {
        res.end();
      } catch {}
    });
    stream.pipe(res);
  } else {
    res.end();
  }
}

async function proxyNative(req, res, config, route, body, fetchImpl) {
  await pipeUpstreamResponse(res, await fetchNative(req, config, route, body, fetchImpl));
}

async function proxyImageGeneration(res, config, body, fetchImpl) {
  const repaired = structuredClone(body);
  repaired.model = config.upstream.image_model;
  const response = await fetchImpl(new URL("/v1/images/generations", config.upstream.base_url), {
    method: "POST",
    headers: imageHeaders(config.upstream),
    body: JSON.stringify(repaired),
  });
  await pipeUpstreamResponse(res, response);
}

function writeEvents(res, events) {
  for (const event of events) res.write(formatResponseEvent(event));
}

async function proxyChat(res, config, route, body, fetchImpl) {
  const chatBody = responsesToChatRequest(
    { ...body, model: route.upstreamModel },
    route.compatibility,
  );
  const response = await fetchImpl(new URL("/v1/chat/completions", config.upstream.base_url), {
    method: "POST",
    headers: upstreamHeaders(config.upstream, chatBody),
    body: JSON.stringify(chatBody),
  });
  if (!response.ok) {
    await pipeUpstreamResponse(res, response);
    return;
  }
  const translator = new ChatResponseTranslator();
  if (chatBody.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        writeEvents(res, translator.push(JSON.parse(data)));
      }
    }
    if (!translator.completed) writeEvents(res, translator.finish({ id: "chat", model: route.upstreamModel }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  const chunk = await response.json();
  const choice = chunk.choices?.[0] || {};
  const events = translator.push({ ...chunk, choices: [{ delta: choice.message || {}, finish_reason: choice.finish_reason || "stop" }] });
  const completed = events.findLast((event) => event.type === "response.completed");
  sendJson(res, 200, completed?.response || { status: "failed", error: { message: "No completion" } });
}

const AUTO_FALLBACK_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

async function proxyAuto(req, res, config, route, body, fetchImpl) {
  const response = await fetchNative(req, config, route, body, fetchImpl);
  if (response.ok || !AUTO_FALLBACK_STATUSES.has(response.status)) {
    await pipeUpstreamResponse(res, response);
    return;
  }
  await response.body?.cancel();
  await proxyChat(res, config, route, body, fetchImpl);
}

function handleModels(res, paths, url) {
  const payload = JSON.parse(fs.readFileSync(paths.catalog, "utf8"));
  if (url.searchParams.has("client_version")) {
    sendJson(res, 200, payload);
    return;
  }
  sendJson(res, 200, {
    object: "list",
    data: (payload.models || []).map((model) => ({
      id: model.slug,
      object: "model",
      created: 0,
      owned_by: "9codex",
    })),
  });
}

export function createGateway(config, paths, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          ready: true,
          service: "9codex",
          version: options.version || "3.0.0",
          pid: process.pid,
          port: config.local.port,
        });
        return;
      }
      if (!authorized(req, config.local.token)) {
        sendJson(res, 401, { error: { code: "invalid_local_token", message: "Invalid 9codex local token" } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        handleModels(res, paths, url);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        await proxyImageGeneration(res, config, await readJson(req), fetchImpl);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        sendJson(res, 404, { error: { code: "not_found", message: "Route not found" } });
        return;
      }
      const body = await readJson(req);
      const route = routeForModel(paths, body.model);
      if (route.protocol === "chat_compat") {
        await proxyChat(res, config, route, body, fetchImpl);
      } else if (route.protocol === "auto") {
        await proxyAuto(req, res, config, route, body, fetchImpl);
      } else if (["responses_native", "responses_compat"].includes(route.protocol)) {
        await proxyNative(req, res, config, route, body, fetchImpl);
      } else {
        sendJson(res, 400, { error: { code: "incompatible_model", message: "Model is not compatible with Codex" } });
      }
    })().catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: { code: "9codex_gateway_error", message: error.message } });
      } else {
        res.destroy(error);
      }
    });
  });
  return server;
}
