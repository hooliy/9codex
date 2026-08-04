import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog } from "../lib/catalog.mjs";
import {
  enableAllModels,
  refreshUpstreamModels,
  selectEnabledModels,
} from "../lib/models.mjs";

test("uses automatic protocol negotiation when an OpenAI model list has no protocol metadata", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "yuanpi-auto",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "yuanpi-auto" }, { id: "model-b", protocol: "chat_compat" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].protocol, "auto");
  assert.equal(rows[1].protocol, "chat_compat");
});

test("selects a model allow-list without hard-coding the upstream catalog", () => {
  const config = {
    upstream: { default_model: "model-a" },
    models: {
      available: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c", enabled: false }],
      enabled_ids: null,
    },
  };

  const selected = selectEnabledModels(config, ["model-b"]);
  assert.deepEqual(selected.models.enabled_ids, ["model-b"]);
  assert.equal(selected.upstream.default_model, "model-b");
  assert.equal(config.models.enabled_ids, null);
  assert.deepEqual(enableAllModels(selected).models.enabled_ids, null);
});

test("rejects selecting unknown or disabled upstream models", () => {
  const config = {
    upstream: { default_model: "model-a" },
    models: {
      available: [{ id: "model-a" }, { id: "model-b", enabled: false }],
    },
  };

  assert.throws(() => selectEnabledModels(config, ["model-b"]), /Unknown or disabled model/);
});

test("keeps native desktop image generation available when model metadata is omitted", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "fangan",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "fangan" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const catalog = buildCatalog({ upstream: config.upstream, models: { available: rows } });

  assert.equal(rows[0].capabilities.image_input, true);
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
});

test("builds reasoning choices for models discovered without capability metadata", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "fangan",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "fangan" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const catalog = buildCatalog({
    upstream: config.upstream,
    models: { available: rows },
  });

  assert.equal(catalog.models[0].default_reasoning_level, "medium");
  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
});

test("respects explicit upstream reasoning capabilities", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "no-reasoning",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [
        { id: "no-reasoning", capabilities: { reasoning: false } },
        {
          id: "custom-reasoning",
          capabilities: { reasoning: true, reasoning_levels: ["low", "high"] },
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].capabilities.reasoning, false);
  assert.deepEqual(rows[0].capabilities.reasoning_levels, []);
  assert.equal(rows[1].capabilities.reasoning, true);
  assert.deepEqual(rows[1].capabilities.reasoning_levels, ["low", "high"]);
});

test("preserves declared image input capability for the Codex model catalog", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "vision-model",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "vision-model", capabilities: { image_input: true } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const catalog = buildCatalog({
    upstream: config.upstream,
    models: { available: rows },
  });

  assert.equal(rows[0].capabilities.image_input, true);
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
});

test("respects an explicit image input opt-out", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "text-only-model",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "text-only-model", capabilities: { image_input: false } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].capabilities.image_input, false);
});
