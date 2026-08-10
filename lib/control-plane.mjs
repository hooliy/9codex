import { reconcileModelState, validateAuthoritativeModels, validateModelState } from "./model-state.mjs";

export class ControlPlaneError extends Error {
  constructor(code, message, status = null) {
    super(message || code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
  }
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, `${String(baseUrl).replace(/\/$/, "")}/`).toString();
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlPlaneError("invalid_json", "Control plane returned invalid JSON", response.status);
  }
}

async function postJson(baseUrl, pathname, body, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(endpoint(baseUrl, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.installationId ? { "x-9codex-installation-id": options.installationId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ControlPlaneError(
      payload?.error?.code || `http_${response.status}`,
      payload?.error?.message || `Control plane request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlPlaneError("invalid_response", `${name} is required`);
  }
}

export async function createAuthorization(baseUrl, payload, options = {}) {
  const result = await postJson(baseUrl, "/v1/cli/authorizations", payload, options);
  requireString(result?.request_id, "request_id");
  requireString(result?.authorization_url, "authorization_url");
  return result;
}

export async function exchangeAuthorizationCode(baseUrl, payload, options = {}) {
  const result = await postJson(baseUrl, "/v1/cli/tokens", payload, options);
  requireString(result?.authorization_id, "authorization_id");
  requireString(result?.access_token, "access_token");
  requireString(result?.refresh_token, "refresh_token");
  return result;
}

export async function refreshAccessToken(config, options = {}) {
  const result = await postJson(
    config.control_plane.base_url,
    "/v1/cli/tokens/refresh",
    {
      authorization_id: config.control_plane.authorization_id,
      refresh_token: config.control_plane.refresh_token,
      installation_id: config.installation.installation_id,
    },
    options,
  );
  requireString(result?.access_token, "access_token");
  return result;
}

function validateBootstrap(payload) {
  requireString(payload?.revision, "bootstrap.revision");
  requireString(payload?.upstream?.base_url, "bootstrap.upstream.base_url");
  if (!/^https?:\/\//.test(payload.upstream.base_url)) {
    throw new ControlPlaneError(
      "invalid_bootstrap",
      "bootstrap.upstream.base_url must be an HTTP(S) URL",
    );
  }
  requireString(payload.upstream.api_key, "bootstrap.upstream.api_key");
  requireString(payload.upstream.default_model, "bootstrap.upstream.default_model");
  requireString(payload.upstream.image_model, "bootstrap.upstream.image_model");
  try {
    validateAuthoritativeModels(payload.models);
  } catch (error) {
    throw new ControlPlaneError("invalid_bootstrap", `bootstrap.models: ${error.message}`);
  }
  if (payload.updates?.npm_package && payload.updates.npm_package !== "@hooliy/9codex") {
    throw new ControlPlaneError("invalid_bootstrap", "bootstrap update package must be @hooliy/9codex");
  }
  return payload;
}

async function fetchBootstrapResponse(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return fetchImpl(endpoint(config.control_plane.base_url, "/v1/agent/bootstrap"), {
    headers: {
      authorization: `Bearer ${config.control_plane.access_token}`,
      "x-9codex-installation-id": config.installation.installation_id,
      ...(config.control_plane.config_revision
        ? { "if-none-match": `"${config.control_plane.config_revision}"` }
        : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  });
}

function applyBootstrap(config, bootstrap, accessToken, tokenExpiresIn) {
  const updated = structuredClone(config);
  updated.control_plane.access_token = accessToken || updated.control_plane.access_token;
  if (tokenExpiresIn) {
    updated.control_plane.access_token_expires_at = new Date(
      Date.now() + Number(tokenExpiresIn) * 1000,
    ).toISOString();
  }
  updated.control_plane.config_revision = bootstrap.revision;
  updated.control_plane.events_url = bootstrap.commands?.events_url || "/v1/agent/events";
  updated.control_plane.heartbeat_interval_seconds =
    Number(bootstrap.commands?.heartbeat_interval_seconds) || 60;
  const priorUpstreamBaseUrl = updated.upstream.base_url;
  updated.upstream = { ...updated.upstream, ...bootstrap.upstream };
  updated.models.available = bootstrap.models;
  updated.models.catalog_revision = bootstrap.catalog_revision || bootstrap.revision;
  updated.models.source_base_url = updated.upstream.base_url;
  if (priorUpstreamBaseUrl !== updated.upstream.base_url) updated.models.enabled_ids = null;
  const targetVersion = bootstrap.updates?.latest_version ?? updated.updates.target_version;
  const npmRegistry = bootstrap.updates?.npm_registry ?? updated.updates.npm_registry;
  updated.updates = {
    ...updated.updates,
    channel: bootstrap.updates?.channel || updated.updates.channel,
    ...(targetVersion === undefined ? {} : { target_version: targetVersion }),
    minimum_version: bootstrap.updates?.minimum_version ?? null,
    ...(npmRegistry === undefined ? {} : { npm_registry: npmRegistry }),
  };
  updated.codex.restart_required = true;
  return updated;
}

export async function syncBootstrap(paths, config, options = {}) {
  let working = structuredClone(config);
  let refreshed = null;
  let response = await fetchBootstrapResponse(working, options);
  if (response.status === 401) {
    const error = await parseResponse(response);
    if (error?.error?.code === "authorization_revoked") {
      throw new ControlPlaneError("authorization_revoked", error.error.message, 401);
    }
    refreshed = await refreshAccessToken(working, options);
    working.control_plane.access_token = refreshed.access_token;
    response = await fetchBootstrapResponse(working, options);
  }
  if (response.status === 304) {
    if (refreshed) {
      working.control_plane.access_token_expires_at = new Date(
        Date.now() + Number(refreshed.access_token_expires_in || 3600) * 1000,
      ).toISOString();
      const reconciled = await reconcileModelState(paths, config, {
        candidateConfig: working,
        authoritativeModels: working.models.available,
      });
      return { changed: true, config: reconciled.config };
    }
    validateModelState(paths, working);
    return { changed: false, config: working };
  }
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ControlPlaneError(
      payload?.error?.code || `http_${response.status}`,
      payload?.error?.message || `Bootstrap failed with HTTP ${response.status}`,
      response.status,
    );
  }
  validateBootstrap(payload);
  const updated = applyBootstrap(
    working,
    payload,
    refreshed?.access_token,
    refreshed?.access_token_expires_in,
  );
  const reconciled = await reconcileModelState(paths, config, {
    candidateConfig: updated,
    authoritativeModels: payload.models,
  });
  return { changed: true, config: reconciled.config, bootstrap: payload };
}

export function sendHeartbeat(config, payload, options = {}) {
  return postJson(config.control_plane.base_url, "/v1/agent/heartbeat", payload, {
    ...options,
    accessToken: config.control_plane.access_token,
    installationId: config.installation.installation_id,
  });
}

export function ackCommand(config, commandId, payload, options = {}) {
  return postJson(
    config.control_plane.base_url,
    `/v1/agent/commands/${encodeURIComponent(commandId)}/ack`,
    payload,
    {
      ...options,
      accessToken: config.control_plane.access_token,
      installationId: config.installation.installation_id,
    },
  );
}
