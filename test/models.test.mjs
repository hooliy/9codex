import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog } from "../lib/catalog.mjs";
import {
  enableAllModels,
  isGptModelId,
  refreshUpstreamModels,
  selectEnabledModels,
} from "../lib/models.mjs";

test("classifies GPT model ids case-insensitively by their final path segment", () => {
  for (const id of ["gpt-5.6-sol", "openai/GPT-4o", "cx/gpt5", "vendor/gpt_oss"]) {
    assert.equal(isGptModelId(id), true, id);
  }
  for (const id of ["claude-opus", "vendor/notgpt-5", "vendor/my-gpt-5", "", null]) {
    assert.equal(isGptModelId(id), false, String(id));
  }
});

test("preserves explicit upstream context and output limits", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "large-context-model",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        id: "large-context-model",
        context_window: 1_050_000,
        max_output_tokens: 128_000,
      }, {
        id: "context-only-model",
        context_window: 256_000,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].context_window, 1_050_000);
  assert.equal(rows[0].max_output_tokens, 128_000);
  assert.equal(rows[1].context_window, 256_000);
  assert.equal(Object.hasOwn(rows[1], "max_output_tokens"), false);
});

test("reads context and output limits from upstream capability metadata", async () => {
  const rows = await refreshUpstreamModels({
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        id: "cx/gpt-5.6-sol",
        capabilities: {
          contextWindow: 372_000,
          maxOutput: 128_000,
        },
      }],
    })),
  });

  assert.equal(rows[0].context_window, 372_000);
  assert.equal(rows[0].max_output_tokens, 128_000);
});

test("does not invent a context window when upstream omits it", async () => {
  const rows = await refreshUpstreamModels({
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
    },
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "fangan" }] }),
    }),
  });

  assert.equal(Object.hasOwn(rows[0], "context_window"), false);
});

test("rejects explicitly invalid context limits with the model id", async () => {
  const invalidValues = [
    undefined,
    null,
    0,
    -1,
    "1050000",
    1.5,
    Number.NaN,
    Infinity,
    -Infinity,
  ];

  for (const context_window of invalidValues) {
    const model = { id: "gpt-5.6-sol", context_window };
    await assert.rejects(
      refreshUpstreamModels({
        upstream: {
          base_url: "https://router.example/v1",
          api_key: "secret",
        },
      }, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [model] }),
        }),
      }),
      /Invalid context_window for model "gpt-5\.6-sol": expected a positive integer/,
    );
  }
});

test("rejects invalid context limits from capability metadata", async () => {
  await assert.rejects(
    refreshUpstreamModels({
      upstream: {
        base_url: "https://router.example/v1",
        api_key: "secret",
      },
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{
          id: "gpt-5.6-sol",
          capabilities: { contextWindow: 0 },
        }],
      })),
    }),
    /Invalid context_window for model "gpt-5\.6-sol": expected a positive integer/,
  );
});

test("rejects invalid optional output limits with the model id", async () => {
  const invalidValues = [null, 0, -1, "128000", 1.5, Number.NaN, Infinity, -Infinity];

  for (const max_output_tokens of invalidValues) {
    await assert.rejects(
      refreshUpstreamModels({
        upstream: {
          base_url: "https://router.example/v1",
          api_key: "secret",
        },
      }, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              id: "broken-output",
              context_window: 1_050_000,
              max_output_tokens,
            }],
          }),
        }),
      }),
      /Invalid max_output_tokens for model "broken-output": expected a positive integer/,
    );
  }
});

test("rewrites legacy model protocols to the native Responses route", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "yuanpi-auto",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [
        { id: "yuanpi-auto", context_window: 200_000 },
        { id: "model-b", context_window: 200_000, protocol: "chat_compat" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].protocol, "responses_native");
  assert.equal(rows[1].protocol, "responses_native");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "yuanpi-auto");
});

test("model refresh does not impose an artificial request deadline", async () => {
  let request;
  await refreshUpstreamModels({
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
    },
  }, {
    fetchImpl: async (_url, options) => {
      request = options;
      return new Response(JSON.stringify({
        data: [{ id: "model-a", context_window: 200_000 }],
      }));
    },
  });

  assert.equal(Object.hasOwn(request, "signal"), false);
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

test("keeps native desktop image generation available when capability metadata is omitted", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "fangan",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "fangan", context_window: 200_000 }],
    }), {
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
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "fangan", context_window: 200_000 }],
    }), {
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
        {
          id: "no-reasoning",
          context_window: 200_000,
          capabilities: { reasoning: false },
        },
        {
          id: "custom-reasoning",
          context_window: 200_000,
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
      data: [{
        id: "vision-model",
        context_window: 200_000,
        capabilities: { image_input: true },
      }],
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
      data: [{
        id: "text-only-model",
        context_window: 200_000,
        capabilities: { image_input: false },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(rows[0].capabilities.image_input, false);
});

test("treats upstream vision:false as image input opt-out", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "no-vision-model",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        id: "no-vision-model",
        context_window: 200_000,
        capabilities: { vision: false },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const catalog = buildCatalog({
    upstream: config.upstream,
    models: { available: rows },
  });

  assert.equal(rows[0].capabilities.image_input, false);
  assert.deepEqual(catalog.models[0].input_modalities, ["text"]);
});

test("model refresh does not retain upstream service tier metadata", async () => {
  const config = {
    upstream: {
      base_url: "https://router.example/v1",
      api_key: "secret",
      default_model: "fast-model",
    },
  };
  const rows = await refreshUpstreamModels(config, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        id: "gpt-5.6-sol",
        context_window: 200_000,
        service_tiers: [
          {
            id: "priority",
            name: "Fast",
            description: "1.5x speed, increased usage",
          },
          { id: "", name: "Broken", description: "invalid" },
        ],
        default_service_tier: "priority",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal("service_tiers" in rows[0], false);
  assert.equal("default_service_tier" in rows[0], false);
});
