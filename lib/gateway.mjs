import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import zlib from "node:zlib";

import { loadValidatedModelState } from "./model-state.mjs";
import { isGptModelId } from "./models.mjs";
import {
  ChatResponseTranslator,
  applyCompatibilityProfile,
  formatResponseEvent,
  normalizeResponsesRequest,
  responsesToChatRequest,
} from "./protocol.mjs";

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
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
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const decoded = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
  return JSON.parse(decoded.toString("utf8"));
}

function routingFromModelMap(payload) {
  return {
    aliases: payload.public_to_upstream || {},
    protocols: payload.upstream_protocols || {},
  };
}

export function routeForModel(paths, requested, defaultModel) {
  const routing = routingFromModelMap(JSON.parse(fs.readFileSync(paths.modelMap, "utf8")));
  return routeFromRouting(routing, requested, defaultModel);
}

function routeFromRouting(routing, requested, defaultModel) {
  let upstreamModel = routing.aliases[requested];
  if (!upstreamModel && routing.protocols[requested]) upstreamModel = requested;
  upstreamModel ||= defaultModel;
  if (!upstreamModel) throw new Error("No default upstream model configured");
  return {
    upstreamModel,
    ...(routing.protocols[upstreamModel] || {
      protocol: "responses_native",
      capabilities: {},
      compatibility: {},
    }),
  };
}

const CODEX_IDENTITY_HEADERS = [
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-openai-subagent",
];

function upstreamHeaders(req, upstream, requestBody) {
  const headers = {
    "content-type": "application/json",
    accept: requestBody.stream === false ? "application/json" : "text/event-stream",
    authorization: `Bearer ${upstream.api_key}`,
  };
  for (const name of CODEX_IDENTITY_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  return headers;
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
  if (isGptModelId(route.upstreamModel)) {
    repaired.service_tier = "priority";
  } else {
    delete repaired.service_tier;
  }
  repaired.model = route.upstreamModel;
  return fetchImpl(new URL(req.url, `${config.upstream.base_url.replace(/\/$/, "")}/`), {
    method: req.method,
    headers: upstreamHeaders(req, config.upstream, repaired),
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
  if (isGptModelId(repaired.model)) {
    repaired.service_tier = "priority";
  } else {
    delete repaired.service_tier;
  }
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

async function proxyChat(req, res, config, route, body, fetchImpl) {
  const routedBody = { ...body, model: route.upstreamModel };
  if (isGptModelId(route.upstreamModel)) {
    routedBody.service_tier = "priority";
  } else {
    delete routedBody.service_tier;
  }
  const chatBody = responsesToChatRequest(
    routedBody,
    route.compatibility,
  );
  const response = await fetchImpl(new URL("/v1/chat/completions", config.upstream.base_url), {
    method: "POST",
    headers: upstreamHeaders(req, config.upstream, chatBody),
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

function handleModels(res, payload, url) {
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
  let activeRequests = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        let ready = false;
        let stateError = null;
        let modelCount = 0;
        try {
          const state = loadValidatedModelState(paths);
          modelCount = state.catalog.models.length;
          ready = modelCount > 0;
          if (!ready) stateError = "Model state contains no usable models";
        } catch (error) {
          stateError = error.message;
        }
        sendJson(res, 200, {
          ok: true,
          ready,
          service: "9codex",
          version: options.version || "3.0.0",
          pid: process.pid,
          port: config.local.port,
          active_requests: activeRequests,
          model_count: modelCount,
          ...(stateError ? { error: stateError } : {}),
        });
        return;
      }
      if (!authorized(req, config.local.token)) {
        sendJson(res, 401, { error: { code: "invalid_local_token", message: "Invalid 9codex local token" } });
        return;
      }
      const modelRoute = (
        req.method === "GET" && url.pathname === "/v1/models"
      ) || (
        req.method === "POST"
        && ["/v1/responses", "/v1/images/generations"].includes(url.pathname)
      );
      if (modelRoute) {
        activeRequests += 1;
        let active = true;
        const complete = () => {
          if (!active) return;
          active = false;
          activeRequests -= 1;
        };
        res.once("finish", complete);
        res.once("close", complete);
      }
      let state;
      if (modelRoute) {
        try {
          state = loadValidatedModelState(paths);
        } catch {
          sendJson(res, 503, {
            error: {
              code: "model_state_unavailable",
              message: "Model state is updating or inconsistent; retry shortly",
            },
          }, { "retry-after": "1" });
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        handleModels(res, state.catalog, url);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/images/generations") {
        await proxyImageGeneration(res, state.config, await readJson(req), fetchImpl);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        sendJson(res, 404, { error: { code: "not_found", message: "Route not found" } });
        return;
      }
      const body = await readJson(req);
      const activeConfig = state.config;
      const route = routeFromRouting(
        routingFromModelMap(state.modelMap),
        body.model,
        activeConfig.upstream.default_model,
      );
      if (route.protocol === "chat_compat") {
        await proxyChat(req, res, activeConfig, route, body, fetchImpl);
      } else if (["responses_native", "responses_compat"].includes(route.protocol)) {
        await proxyNative(req, res, activeConfig, route, body, fetchImpl);
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
