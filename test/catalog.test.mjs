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
  assert.equal(result.models[0].slug, "9codex/vendor-model-a");
  assert.equal(result.models[0].display_name, "Model A");
  assert.equal(result.models[0].supports_parallel_tool_calls, false);
  assert.equal(result.models[0].supports_image_detail_original, false);
  assert.deepEqual(
    result.models[0].supported_reasoning_levels.map((row) => row.effort),
    ["low", "medium"],
  );
  assert.equal(result.map["9codex/vendor-model-a"], "vendor/model-a");
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

test("catalog rows include the experimental tool list required by Codex Desktop", () => {
  const result = buildCatalog(config());

  assert.deepEqual(result.models[0].experimental_supported_tools, []);
});

test("fallback catalog keeps native desktop image generation available", () => {
  const result = buildCatalog({
    upstream: { default_model: "fallback-model" },
    models: { namespace: "9codex", available: [] },
  });

  assert.deepEqual(result.models[0].input_modalities, ["text", "image"]);
});

test("does not expose a model catalog cached from another upstream", () => {
  const result = buildCatalog({
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
        protocol: "responses_native",
        capabilities: { tools: true },
      }],
    },
  });

  assert.deepEqual(result.models.map((model) => model.slug), ["9codex/yuanpi-auto"]);
  assert.deepEqual(result.map, { "9codex/yuanpi-auto": "yuanpi-auto" });
});

test("catalog exposes only explicitly selected models", () => {
  const result = buildCatalog({
    upstream: { default_model: "model-a" },
    models: {
      namespace: "9codex",
      enabled_ids: ["model-b"],
      available: [
        { id: "model-a", enabled: true, capabilities: {} },
        { id: "model-b", enabled: true, capabilities: {} },
      ],
    },
  });

  assert.deepEqual(result.models.map((model) => model.slug), ["9codex/model-b"]);
});

test("writes only 9codex-owned catalog files and leaves Codex cache untouched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-catalog-test-"));
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.codexHome, { recursive: true });
  const nativeCache = path.join(paths.codexHome, "models_cache.json");
  fs.writeFileSync(nativeCache, "native-cache-sentinel");

  writeCatalog(paths, buildCatalog(config()));

  assert.equal(JSON.parse(fs.readFileSync(paths.catalog, "utf8")).models.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(paths.modelMap, "utf8")).public_to_upstream["9codex/vendor-model-a"], "vendor/model-a");
  assert.equal(fs.readFileSync(nativeCache, "utf8"), "native-cache-sentinel");
});
