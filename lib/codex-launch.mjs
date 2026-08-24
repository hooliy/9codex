import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";

export const CODEX_AUTH_ENV = "NINECODEX_CODEX_API_KEY";

export function resolveCodexCommand(options = {}) {
  if (options.command) return options.command;
  const platform = options.platform || process.platform;
  const candidates = platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "codex",
      ]
    : platform === "win32"
      ? [
          `${process.env.LOCALAPPDATA || ""}\\Programs\\ChatGPT\\resources\\codex.exe`,
          "codex.exe",
        ]
      : ["/usr/local/bin/codex", "/usr/bin/codex", "codex"];
  return candidates.find((candidate) => (
    (candidate.includes("/") || candidate.includes("\\"))
    && (options.exists || fs.existsSync)(candidate)
  )) || candidates.at(-1);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function toml(value) {
  return JSON.stringify(value);
}

function override(key, value) {
  return ["-c", `${key}=${toml(value)}`];
}

export function buildCodexLaunch(options = {}) {
  const config = options.config;
  const paths = options.paths;
  const command = resolveCodexCommand(options);
  const workspace = options.workspace || process.cwd();
  const model = options.model || config?.upstream?.default_model;
  const modelCatalogJson = options.modelCatalogJson || options.catalogPath || paths?.catalog;
  const baseUrl = options.baseUrl
    || (config?.local && `http://${config.local.host}:${config.local.port}/v1`);
  const authEnvKey = options.authEnvKey || CODEX_AUTH_ENV;
  const token = options.token || config?.local?.token || options.env?.[authEnvKey];
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || process.argv[1];
  const serviceTier = options.serviceTier || "priority";

  [
    [command, "command"],
    [workspace, "workspace"],
    [model, "model"],
    [modelCatalogJson, "modelCatalogJson"],
    [baseUrl, "baseUrl"],
    [authEnvKey, "authEnvKey"],
    [token, `env.${authEnvKey}`],
    [nodePath, "nodePath"],
    [cliPath, "cliPath"],
    [serviceTier, "serviceTier"],
  ].forEach(([value, name]) => requireString(value, name));

  const args = [
    "app",
    ...override("model", model),
    ...override("model_provider", "9codex"),
    ...override("model_catalog_json", modelCatalogJson),
    ...override("model_providers.9codex.name", "9codex"),
    ...override("model_providers.9codex.base_url", baseUrl),
    ...override("model_providers.9codex.wire_api", "responses"),
    ...override("model_providers.9codex.supports_websockets", false),
    ...override("model_providers.9codex.env_key", authEnvKey),
    ...override("service_tier", serviceTier),
    ...override("features.multi_agent", true),
    ...override("multi_agent_mode", "proactive"),
    ...override("mcp_servers.9codex.command", nodePath),
    ...override("mcp_servers.9codex.args", [cliPath, "mcp"]),
    ...override("mcp_servers.9codex.default_tools_approval_mode", "approve"),
    workspace,
  ];

  return {
    command,
    args,
    options: {
      env: { ...(options.env || process.env), [authEnvKey]: token },
      shell: false,
      stdio: "inherit",
    },
  };
}

export function launchCodexDesktop(options = {}) {
  const launch = buildCodexLaunch(options);
  return (options.spawn || spawnProcess)(launch.command, launch.args, launch.options);
}
