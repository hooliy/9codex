const DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const PRODUCT_CONTEXT_WINDOW = 1_050_000;

export function isGptModelId(value) {
  if (typeof value !== "string") return false;
  const model = value.trim().split("/").at(-1) || "";
  return /^gpt(?:$|[-_.]|\d)/i.test(model);
}

function positiveIntegerField(row, field, optional = false) {
  const value = row[field];
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field} for model "${row.id}": expected a positive integer`);
  }
  return value;
}

function contextWindowField(row) {
  return Object.hasOwn(row, "context_window")
    ? positiveIntegerField(row, "context_window")
    : PRODUCT_CONTEXT_WINDOW;
}

function selectableModelIds(config) {
  return new Set(
    (config.models?.available || [])
      .filter((row) => row?.enabled !== false && typeof row?.id === "string")
      .map((row) => row.id),
  );
}

export function selectEnabledModels(config, ids) {
  const selected = [...new Set(ids)];
  if (selected.length === 0) throw new Error("Select at least one model");
  const available = selectableModelIds(config);
  const unknown = selected.filter((id) => !available.has(id));
  if (unknown.length > 0) throw new Error(`Unknown or disabled model: ${unknown.join(", ")}`);
  const updated = structuredClone(config);
  updated.models.enabled_ids = selected;
  if (!selected.includes(updated.upstream.default_model)) {
    updated.upstream.default_model = selected[0];
  }
  return updated;
}

export function enableAllModels(config) {
  const updated = structuredClone(config);
  updated.models.enabled_ids = null;
  const available = [...selectableModelIds(updated)];
  if (available.length > 0 && !available.includes(updated.upstream.default_model)) {
    updated.upstream.default_model = available[0];
  }
  return updated;
}

export async function refreshUpstreamModels(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${config.upstream.base_url.replace(/\/$/, "")}/models`;
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${config.upstream.api_key}` },
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  });
  if (!response.ok) throw new Error(`Upstream model catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload?.data)
    ? payload.data.filter((row) => typeof row?.id === "string" && row.id.length > 0)
    : [];
  if (rows.length === 0) throw new Error("Upstream returned no model ids");
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).map((row) => {
    const declared = row.capabilities || {};
    const supportsReasoning = declared.reasoning !== false;
    const reasoningLevels = supportsReasoning && Array.isArray(declared.reasoning_levels)
      && declared.reasoning_levels.length > 0
      ? declared.reasoning_levels
      : supportsReasoning ? DEFAULT_REASONING_LEVELS : [];
    const contextWindow = contextWindowField(row);
    const maxOutputTokens = positiveIntegerField(row, "max_output_tokens", true);
    return {
      id: row.id,
      display_name: row.display_name || row.id,
      enabled: row.enabled !== false,
      protocol: ["responses_native", "responses_compat", "chat_compat", "auto"].includes(row.protocol)
        ? row.protocol
        : "auto",
      context_window: contextWindow,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
      capabilities: {
        streaming: true,
        tools: true,
        parallel_tools: false,
        reasoning: supportsReasoning,
        reasoning_levels: reasoningLevels,
        image_input: declared.image_input !== false && declared.vision !== false,
        structured_output: false,
      },
      compatibility: row.compatibility || {
        strip_request_fields: [],
        rename_request_fields: {},
      },
    };
  });
}
