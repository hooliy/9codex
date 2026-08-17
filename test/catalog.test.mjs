import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCatalog, writeCatalog } from "../lib/catalog.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function config() {
  return {
    upstream: { default_model: "vendor/model-a" },
    models: {
      namespace: "9codex",
      available: [
        {
          id: "vendor/model-a",
          display_name: "Model A",
          enabled: true,
          protocol: "responses_native",
          context_window: 64000,
          capabilities: {
            streaming: true,
            tools: true,
            parallel_tools: false,
            reasoning: true,
            reasoning_levels: ["low", "medium"],
            image_input: false,
            structured_output: false,
          },
        },
        {
          id: "vendor/broken",
          display_name: "Broken",
          enabled: false,
          protocol: "chat_compat",
          capabilities: { streaming: false, tools: false },
        },
      ],
    },
  };
}

test("catalog advertises only verified capabilities and enabled models", () => {
  const result = buildCatalog(config());

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].slug, "vendor/model-a");
  assert.equal(result.models[0].display_name, "Model A");
  assert.equal(result.models[0].supports_parallel_tool_calls, false);
  assert.equal(result.models[0].supports_image_detail_original, false);
  assert.deepEqual(result.models[0].service_tiers, []);
  assert.equal("additional_speed_tiers" in result.models[0], false);
  assert.equal(result.models[0].default_service_tier, null);
  assert.deepEqual(
    result.models[0].supported_reasoning_levels.map((row) => row.effort),
    ["low", "medium"],
  );
  assert.equal(result.map["vendor/model-a"], "vendor/model-a");
});

test("catalog rows include the shell type required by Codex Desktop", () => {
  const result = buildCatalog(config());

  assert.equal(result.models[0].shell_type, "shell_command");
});

test("catalog rows include the truncation policy required by Codex Desktop", () => {
  const result = buildCatalog(config());

  assert.deepEqual(result.models[0].truncation_policy, {
    mode: "tokens",
    limit: 10000,
  });
});

test("catalog preserves a 1.05M context window with a fixed 90 percent effective limit", () => {
  const value = config();
  value.models.available[0].context_window = 1_050_000;

  const model = buildCatalog(value).models[0];

  assert.equal(model.context_window, 1_050_000);
  assert.equal(model.max_context_window, 1_050_000);
  assert.equal(model.effective_context_window_percent, 90);
  assert.equal(model.context_window * model.effective_context_window_percent / 100, 945_000);
});

test("catalog compresses a 372k model at 334.8k", () => {
  const value = config();
  value.models.available[0].context_window = 372_000;

  const model = buildCatalog(value).models[0];

  assert.equal(model.context_window, 372_000);
  assert.equal(model.effective_context_window_percent, 90);
  assert.equal(model.context_window * model.effective_context_window_percent / 100, 334_800);
});

test("catalog rejects missing or invalid context windows", () => {
  for (const contextWindow of [
    undefined,
    null,
    0,
    -1,
    1.5,
    "1050000",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const value = config();
    value.models.available[0].context_window = contextWindow;

    assert.throws(
      () => buildCatalog(value),
      /Invalid context_window for model "vendor\/model-a": expected a positive integer/,
    );
  }
});

test("catalog rows include the experimental tool list required by Codex Desktop", () => {
  const result = buildCatalog(config());

  assert.deepEqual(result.models[0].experimental_supported_tools, []);
});

test("catalog advertises Fast for GPT models without upstream service tier metadata", () => {
  const ids = [
    "gpt-5.6-sol",
    "openai/gpt-5.6-sol",
    "CX/GPT-5.6-SOL",
    "vendor/gpt5",
  ];
  const result = buildCatalog({
    upstream: { default_model: ids[0] },
    models: {
      namespace: "9codex",
      available: ids.map((id) => ({
        id,
        enabled: true,
        context_window: 1_050_000,
        capabilities: {},
      })),
    },
  });

  for (const model of result.models) {
    assert.deepEqual(model.service_tiers, [{
      id: "priority",
      name: "Fast",
      description: "1.5x speed, increased usage",
    }]);
    assert.equal(model.default_service_tier, null);
  }
});

test("catalog exposes a selectable Fast model because Codex hides service tiers for custom providers", () => {
  const result = buildCatalog({
    upstream: { default_model: "cx/gpt-5.6-sol" },
    models: {
      namespace: "9codex",
      available: [{
        id: "cx/gpt-5.6-sol",
        display_name: "GPT 5.6 Sol",
        enabled: true,
        context_window: 1_050_000,
        capabilities: { reasoning: true, reasoning_levels: ["medium"] },
      }],
    },
  });

  assert.equal(result.models.length, 2);
  const fast = result.models.find((model) => model.display_name === "GPT 5.6 Sol · 快速模式");
  assert.ok(fast);
  assert.notEqual(fast.slug, "cx/gpt-5.6-sol");
  assert.equal(result.map[fast.slug], "cx/gpt-5.6-sol");
  assert.equal(result.forcedServiceTiers[fast.slug], "priority");
  assert.equal(fast.context_window, 1_050_000);
  assert.equal(fast.max_context_window, 1_050_000);
  assert.equal(
    fast.effective_context_window_percent,
    result.models.find((model) => model.slug === "cx/gpt-5.6-sol")
      .effective_context_window_percent,
  );
});

test("catalog does not advertise Fast for non-GPT models even when upstream declares priority", () => {
  const result = buildCatalog({
    upstream: { default_model: "standard-model" },
    models: {
      namespace: "9codex",
      available: [{
        id: "standard-model",
        enabled: true,
        context_window: 64000,
        service_tiers: [{
          id: "priority",
          name: "Fast",
          description: "upstream claim",
        }],
        default_service_tier: "priority",
        capabilities: { image_input: true },
      }],
    },
  });

  assert.deepEqual(result.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(result.models[0].service_tiers, []);
  assert.equal("additional_speed_tiers" in result.models[0], false);
  assert.equal(result.models[0].default_service_tier, null);
});

test("catalog fails when model metadata belongs to another upstream", () => {
  assert.throws(
    () => buildCatalog({
      upstream: {
        base_url: "https://new-router.example/v1",
        default_model: "yuanpi-auto",
      },
      models: {
        namespace: "9codex",
        source_base_url: "https://old-router.example/v1",
        available: [{
          id: "old-router-model",
          enabled: true,
          context_window: 64000,
          protocol: "responses_native",
          capabilities: { tools: true },
        }],
      },
    }),
    /Model catalog source does not match configured upstream/,
  );
});

test("catalog fails when no usable model metadata remains", () => {
  const unusableModels = [
    undefined,
    [],
    [{ id: "disabled", enabled: false, context_window: 64000 }],
    [{ id: "", enabled: true, context_window: 64000 }],
  ];

  for (const available of unusableModels) {
    assert.throws(
      () => buildCatalog({
        upstream: { default_model: "model-a" },
        models: { available },
      }),
      /No usable model metadata available/,
    );
  }

  assert.throws(
    () => buildCatalog({
      upstream: { default_model: "model-a" },
      models: {
        enabled_ids: ["missing"],
        available: [{ id: "model-a", enabled: true, context_window: 64000 }],
      },
    }),
    /No usable model metadata available/,
  );
});

test("catalog exposes only explicitly selected models", () => {
  const result = buildCatalog({
    upstream: { default_model: "model-a" },
    models: {
      namespace: "9codex",
      enabled_ids: ["model-b"],
      available: [
        { id: "model-a", enabled: true, context_window: 64000, capabilities: {} },
        { id: "model-b", enabled: true, context_window: 64000, capabilities: {} },
      ],
    },
  });

  assert.deepEqual(result.models.map((model) => model.slug), ["model-b"]);
});

test("writes only 9codex-owned catalog files and leaves Codex cache untouched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-catalog-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const nativeCache = path.join(paths.codexHome, "models_cache.json");
  fs.writeFileSync(nativeCache, "native-cache-sentinel");

  writeCatalog(paths, buildCatalog(config()));

  assert.equal(JSON.parse(fs.readFileSync(paths.catalog, "utf8")).models.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(paths.modelMap, "utf8")).public_to_upstream["vendor/model-a"], "vendor/model-a");
  assert.equal(fs.readFileSync(nativeCache, "utf8"), "native-cache-sentinel");
});
