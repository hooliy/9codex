import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isGptModelId } from "./models.mjs";

const REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex work",
  xhigh: "Extra-high reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning with task delegation",
};

const FAST_SERVICE_TIER = {
  id: "priority",
  name: "Fast",
  description: "1.5x speed, increased usage",
};

const BASE_INSTRUCTIONS = [
  "You are Codex, a coding agent.",
  "Execute simple tasks directly.",
  "For complex tasks with independent work, use Codex native sub-agents in parallel.",
  "When the user asks to create, draw, render, or generate an image, call the mcp__9codex__image_gen tool.",
  "Never answer an image-generation request without calling that tool.",
  "Never use an external orchestrator.",
  "Do not restrict Codex native capabilities.",
].join(" ");

function catalogRow(row, slug, displayName, serviceTiers, priority) {
  const capabilities = row.capabilities || {};
  const supportsImageInput = capabilities.image_input !== false;
  const reasoningLevels = capabilities.reasoning
    ? (capabilities.reasoning_levels || []).map((effort) => ({
        effort,
        description: REASONING_DESCRIPTIONS[effort] || `${effort} reasoning`,
      }))
    : [];
  return {
    slug,
    display_name: displayName,
    description: "Routed locally by 9codex.",
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: BASE_INSTRUCTIONS,
    shell_type: "shell_command",
    default_reasoning_level: reasoningLevels.some((item) => item.effort === "medium")
      ? "medium"
      : reasoningLevels[0]?.effort || "low",
    supported_reasoning_levels: reasoningLevels,
    support_verbosity: Boolean(capabilities.reasoning),
    default_verbosity: "medium",
    apply_patch_tool_type: capabilities.tools ? "freeform" : null,
    supports_parallel_tool_calls: Boolean(capabilities.tools && capabilities.parallel_tools),
    supports_image_detail_original: supportsImageInput,
    input_modalities: supportsImageInput ? ["text", "image"] : ["text"],
    context_window: row.context_window,
    max_context_window: row.context_window,
    effective_context_window_percent: 100,
    truncation_policy: {
      mode: "tokens",
      limit: row.context_window,
    },
    service_tiers: serviceTiers,
    default_service_tier: serviceTiers.length > 0 ? "priority" : null,
    experimental_supported_tools: [],
    use_responses_lite: false,
    supports_websockets: false,
    prefer_websockets: false,
  };
}

export function buildCatalog(config) {
  if (config.models?.source_base_url
    && config.models.source_base_url !== config.upstream?.base_url) {
    throw new Error("Model catalog source does not match configured upstream");
  }
  const source = config.models?.available;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("No usable model metadata available");
  }
  const map = {};
  const protocols = {};
  const models = [];
  const enabledIds = Array.isArray(config.models?.enabled_ids)
    ? new Set(config.models.enabled_ids)
    : null;
  for (const row of source) {
    if (row?.enabled === false || typeof row?.id !== "string" || row.id.length === 0) continue;
    if (enabledIds && !enabledIds.has(row.id)) continue;
    if (!Number.isSafeInteger(row.context_window) || row.context_window <= 0) {
      throw new Error(`Invalid context_window for model "${row.id}": expected a positive integer`);
    }
    const capabilities = row.capabilities || {};
    const serviceTiers = isGptModelId(row.id) ? [FAST_SERVICE_TIER] : [];
    const slug = row.id;
    map[slug] = row.id;
    protocols[row.id] = {
      protocol: "responses_native",
      capabilities,
      compatibility: row.compatibility || {},
    };
    models.push(catalogRow(
      row,
      slug,
      row.display_name || row.id,
      serviceTiers,
      models.length + 1,
    ));
  }
  if (models.length === 0) throw new Error("No usable model metadata available");
  if (!Object.hasOwn(map, config.upstream?.default_model)) {
    throw new Error(`Default model "${config.upstream?.default_model}" is not enabled in model catalog`);
  }
  return { models, map, protocols, forcedServiceTiers: {} };
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
    forced_service_tiers: built.forcedServiceTiers,
  });
}
