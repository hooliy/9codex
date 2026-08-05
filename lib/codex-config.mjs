import fs from "node:fs";
import path from "node:path";

const ROOT_KEYS = new Set(["model", "model_provider", "model_catalog_json"]);
const MARKERS = {
  rootStart: "# BEGIN 9codex root",
  rootEnd: "# END 9codex root",
  providerStart: "# BEGIN 9codex provider",
  providerEnd: "# END 9codex provider",
  mcpStart: "# BEGIN 9codex mcp",
  mcpEnd: "# END 9codex mcp",
};
function publicModel(id) {
  return `9codex/${String(id).replaceAll("/", "-")}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function stripManagedBlocks(lines) {
  const output = [];
  let dropping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === MARKERS.rootStart ||
      trimmed === MARKERS.providerStart ||
      trimmed === MARKERS.mcpStart
    ) {
      dropping = true;
      continue;
    }
    if (
      trimmed === MARKERS.rootEnd ||
      trimmed === MARKERS.providerEnd ||
      trimmed === MARKERS.mcpEnd
    ) {
      dropping = false;
      continue;
    }
    if (!dropping) output.push(line);
  }
  return output;
}

function stripOwnedRootKeys(lines) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  return lines.filter((line, index) => {
    if (index >= rootEnd) return true;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    return !match || !ROOT_KEYS.has(match[1]);
  });
}

function saveInstallState(paths, original, existed) {
  if (fs.existsSync(paths.codexState)) return;
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.codexState, `${JSON.stringify({
    config_existed: existed,
    original_base64: original.toString("base64"),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.codexState, 0o600);
}

export function injectCodexConfig(paths, config, options = {}) {
  if (config.codex?.inject_config === false) return false;
  const existed = fs.existsSync(paths.codexConfig);
  const original = existed ? fs.readFileSync(paths.codexConfig) : Buffer.alloc(0);
  saveInstallState(paths, original, existed);

  const current = original.toString("utf8");
  let lines = stripManagedBlocks(current.split(/\r?\n/));
  lines = stripOwnedRootKeys(lines);
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();

  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  const tableLines = firstTable === -1 ? [] : lines.slice(firstTable);
  while (rootLines.length > 0 && rootLines.at(-1) === "") rootLines.pop();
  while (tableLines.length > 0 && tableLines[0] === "") tableLines.shift();
  const bridgeUrl = `http://127.0.0.1:${config.local.port}/v1`;
  const rootBlock = [
    MARKERS.rootStart,
    `model = ${tomlString(publicModel(config.upstream.default_model))}`,
    `model_provider = "9codex"`,
    `model_catalog_json = ${tomlString(paths.catalog)}`,
    MARKERS.rootEnd,
  ];
  const providerBlock = [
    MARKERS.providerStart,
    "[model_providers.9codex]",
    'name = "9codex"',
    `base_url = ${tomlString(bridgeUrl)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    `experimental_bearer_token = ${tomlString(config.local.token)}`,
    'http_headers = { "x-openai-actor-authorization" = "9codex-local" }',
    MARKERS.providerEnd,
  ];
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || process.argv[1];
  const mcpBlock = [
    MARKERS.mcpStart,
    "[mcp_servers.9codex]",
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(cliPath)}, "mcp"]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 180",
    'default_tools_approval_mode = "approve"',
    MARKERS.mcpEnd,
  ];
  const rendered = [
    ...rootBlock,
    ...(rootLines.length > 0 ? ["", ...rootLines] : []),
    "",
    ...providerBlock,
    "",
    ...mcpBlock,
    ...(tableLines.length > 0 ? ["", ...tableLines] : []),
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
  fs.writeFileSync(paths.codexConfig, rendered);
  return true;
}

export function restoreCodexConfig(paths) {
  if (!fs.existsSync(paths.codexState)) return false;
  const state = JSON.parse(fs.readFileSync(paths.codexState, "utf8"));
  if (state.config_existed) {
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(paths.codexConfig, Buffer.from(state.original_base64, "base64"));
  } else if (fs.existsSync(paths.codexConfig)) {
    fs.unlinkSync(paths.codexConfig);
  }
  fs.unlinkSync(paths.codexState);
  return true;
}
