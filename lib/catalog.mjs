import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex work",
  xhigh: "Extra-high reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning with task delegation",
};

function publicSlug(id) {
  return `9codex/${String(id).replaceAll("/", "-")}`;
}

function defaultRow(config) {
  return {
    id: config.upstream.default_model,
    display_name: config.upstream.default_model,
    enabled: true,
    protocol: "responses_native",
    context_window: 128000,
    capabilities: {
      streaming: true,
      tools: true,
      parallel_tools: false,
      reasoning: false,
      reasoning_levels: [],
      image_input: true,
      structured_output: false,
    },
  };
}

export function buildCatalog(config) {
  const catalogMatchesUpstream = !config.models?.source_base_url
    || config.models.source_base_url === config.upstream?.base_url;
  const source = catalogMatchesUpstream
    && Array.isArray(config.models?.available)
    && config.models.available.length > 0
    ? config.models.available
    : [defaultRow(config)];
  const map = {};
  const protocols = {};
  const models = [];
  const enabledIds = Array.isArray(config.models?.enabled_ids)
    ? new Set(config.models.enabled_ids)
    : null;
  for (const row of source) {
    if (row?.enabled === false || typeof row?.id !== "string" || row.id.length === 0) continue;
    if (enabledIds && !enabledIds.has(row.id)) continue;
    const capabilities = row.capabilities || {};
    const supportsImageInput = capabilities.image_input !== false;
    const slug = publicSlug(row.id);
    map[slug] = row.id;
    protocols[row.id] = {
      protocol: row.protocol || "responses_native",
      capabilities,
      compatibility: row.compatibility || {},
    };
    const reasoningLevels = capabilities.reasoning
      ? (capabilities.reasoning_levels || []).map((effort) => ({
          effort,
          description: REASONING_DESCRIPTIONS[effort] || `${effort} reasoning`,
        }))
      : [];
    models.push({
      slug,
      display_name: row.display_name || row.id,
      description: "Routed locally by 9codex.",
      visibility: "list",
      supported_in_api: true,
      priority: models.length + 1,
      base_instructions: "You are Codex, a coding agent.",
      shell_type: "shell_command",
      default_reasoning_level: reasoningLevels.some((item) => item.effort === "medium")
        ? "medium"
        : reasoningLevels[0]?.effort || "low",
      supported_reasoning_levels: reasoningLevels,
      support_verbosity: Boolean(capabilities.reasoning),
      default_verbosity: "medium",
      apply_patch_tool_type: capabilities.tools ? "freeform" : null,
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: Boolean(capabilities.tools && capabilities.parallel_tools),
      supports_image_detail_original: supportsImageInput,
      input_modalities: supportsImageInput ? ["text", "image"] : ["text"],
      context_window: Number(row.context_window) || 128000,
      max_context_window: Number(row.context_window) || 128000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      use_responses_lite: false,
      supports_websockets: false,
      prefer_websockets: false,
    });
  }
  return { models, map, protocols };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function writeCatalog(paths, built) {
  writeJsonAtomic(paths.catalog, { models: built.models });
  writeJsonAtomic(paths.modelMap, {
    namespace: "9codex",
    public_to_upstream: built.map,
    upstream_protocols: built.protocols,
  });
}
