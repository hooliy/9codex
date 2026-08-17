import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token",
  "api_key",
  "ninecodex_harness_api_key",
  "authorization",
]);

function requireString(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string${nullable ? " or null" : ""}`);
  }
}

function harnessDefaults() {
  return {
    command: "dsh-jsonrpc-agent",
    args: [],
    cordis_config: null,
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    max_tokens: null,
    request_timeout_ms: 300_000,
  };
}

function teamDefaults(localToken) {
  const token = crypto.createHash("sha256").update(String(localToken)).digest("hex");
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 10102,
    token: `9codex_team_${token}`,
    max_workers: 3,
    lease_seconds: 60,
    backup_interval_seconds: 3600,
    harness: harnessDefaults(),
  };
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("config must be an object");
  if (config.schema_version !== 1) throw new Error("schema_version must equal 1");
  requireString(config.installation?.installation_id, "installation.installation_id");
  requireString(config.control_plane?.base_url, "control_plane.base_url", { nullable: true });
  if (config.local?.host !== "127.0.0.1") throw new Error("local.host must equal 127.0.0.1");
  if (!Number.isInteger(config.local?.port) || config.local.port < 1 || config.local.port > 65535) {
    throw new Error("local.port must be an integer from 1 to 65535");
  }
  requireString(config.local?.token, "local.token");
  requireString(config.upstream?.base_url, "upstream.base_url", { nullable: true });
  if (config.upstream.base_url !== null && !/^https?:\/\//.test(config.upstream.base_url)) {
    throw new Error("upstream.base_url must be an HTTP(S) URL");
  }
  requireString(config.upstream?.api_key, "upstream.api_key", { nullable: true });
  requireString(config.upstream?.default_model, "upstream.default_model");
  requireString(config.upstream?.image_model, "upstream.image_model");
  if (config.models?.namespace !== "9codex") throw new Error("models.namespace must equal 9codex");
  if (
    !Number.isInteger(config.models?.refresh_interval_seconds) ||
    config.models.refresh_interval_seconds < 30
  ) {
    throw new Error("models.refresh_interval_seconds must be an integer of at least 30");
  }
  if (
    config.models?.enabled_ids != null
    && (
      !Array.isArray(config.models.enabled_ids)
      || config.models.enabled_ids.length === 0
      || config.models.enabled_ids.some((id) => typeof id !== "string" || id.length === 0)
    )
  ) {
    throw new Error("models.enabled_ids must be null or a non-empty array of model ids");
  }
  if (!config.updates || typeof config.updates !== "object") throw new Error("updates is required");
  if (!config.codex || typeof config.codex !== "object") throw new Error("codex is required");
  if (!['automatic', 'notify'].includes(config.codex.restart_policy)) {
    throw new Error("codex.restart_policy must be automatic or notify");
  }
  // Existing 1.x configs predate the team runtime. Derive a stable private token
  // from the existing local secret instead of forcing an interactive migration.
  config.team ||= teamDefaults(config.local.token);
  if (typeof config.team !== "object") throw new Error("team must be an object");
  if (config.team.host !== "127.0.0.1") throw new Error("team.host must equal 127.0.0.1");
  if (!Number.isInteger(config.team.port) || config.team.port < 1 || config.team.port > 65535) {
    throw new Error("team.port must be an integer from 1 to 65535");
  }
  requireString(config.team.token, "team.token");
  if (!Number.isInteger(config.team.max_workers) || config.team.max_workers < 1 || config.team.max_workers > 20) {
    throw new Error("team.max_workers must be an integer from 1 to 20");
  }
  config.team.harness ||= harnessDefaults();
  if (typeof config.team.harness !== "object" || Array.isArray(config.team.harness)) {
    throw new Error("team.harness must be an object");
  }
  requireString(config.team.harness.command, "team.harness.command");
  if (
    !Array.isArray(config.team.harness.args)
    || config.team.harness.args.some((value) => typeof value !== "string")
  ) {
    throw new Error("team.harness.args must be an array of strings");
  }
  requireString(config.team.harness.cordis_config, "team.harness.cordis_config", { nullable: true });
  requireString(config.team.harness.provider, "team.harness.provider");
  requireString(config.team.harness.model, "team.harness.model");
  if (
    config.team.harness.max_tokens !== null
    && (!Number.isInteger(config.team.harness.max_tokens) || config.team.harness.max_tokens < 1)
  ) {
    throw new Error("team.harness.max_tokens must be null or a positive integer");
  }
  if (
    !Number.isInteger(config.team.harness.request_timeout_ms)
    || config.team.harness.request_timeout_ms < 1
  ) {
    throw new Error("team.harness.request_timeout_ms must be a positive integer");
  }
  return config;
}

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, text, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

export function saveConfigAtomic(paths, config) {
  validateConfig(config);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(paths.config)) {
    const active = fs.readFileSync(paths.config, "utf8");
    atomicWrite(paths.lastGoodConfig, active);
  }
  atomicWrite(paths.pendingConfig, text);
  fs.renameSync(paths.pendingConfig, paths.config);
  fs.chmodSync(paths.config, 0o600);
  return config;
}

export function loadConfig(paths) {
  const parsed = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  return validateConfig(parsed);
}

export function defaultConfig(options = {}) {
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const token = randomBytes(24).toString("hex");
  return {
    schema_version: 1,
    installation: {
      installation_id: `ins_${randomBytes(12).toString("hex")}`,
      device_name: options.deviceName || null,
      created_at: (options.now || new Date()).toISOString(),
    },
    control_plane: {
      base_url: null,
      authorization_id: null,
      access_token: null,
      access_token_expires_at: null,
      refresh_token: null,
      config_revision: null,
      poll_interval_seconds: 300,
      events_enabled: false,
    },
    local: {
      host: "127.0.0.1",
      port: 10101,
      token: `9codex_local_${token}`,
    },
    upstream: {
      base_url: null,
      api_key: null,
      default_model: "yuanpi-auto",
      image_model: "cx/gpt-5.5-image",
    },
    models: {
      namespace: "9codex",
      refresh_interval_seconds: 300,
      catalog_revision: null,
      source_base_url: null,
      enabled_ids: null,
      available: [],
    },
    updates: {
      enabled: true,
      channel: "stable",
      auto_install: true,
      target_version: null,
      npm_registry: "https://registry.npmjs.org",
    },
    codex: {
      inject_config: true,
      restart_policy: "automatic",
      restart_required: false,
    },
    team: teamDefaults(`9codex_local_${token}`),
  };
}

export function migrateLegacyConfig(paths, options = {}) {
  const legacy = JSON.parse(fs.readFileSync(paths.legacyConfig, "utf8"));
  const config = defaultConfig(options);
  config.local.port = legacy.bridge_port ?? config.local.port;
  config.upstream.base_url = legacy.router9_url;
  config.upstream.api_key = legacy.router9_key;
  config.upstream.default_model = legacy.model || config.upstream.default_model;
  config.upstream.image_model = legacy.image_model || config.upstream.image_model;
  config.models.refresh_interval_seconds =
    legacy.model_refresh_interval ?? config.models.refresh_interval_seconds;
  config.codex.inject_config = legacy.inject_config !== false;
  return config;
}

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactConfig(child),
    ]),
  );
}
