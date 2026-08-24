import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadConfig } from "../lib/config.mjs";
import {
  recoverModelState,
  reconcileModelState,
  validateAuthoritativeModels,
  validateModelState,
} from "../lib/model-state.mjs";
import { resolvePaths } from "../lib/paths.mjs";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-model-state-test-"));
  const paths = resolvePaths(home);
  const config = defaultConfig();
  config.upstream.base_url = "https://old.example/v1";
  config.upstream.api_key = "old-key";
  config.upstream.default_model = "old-model";
  return { home, paths, config };
}

function model(id = "old-model", contextWindow = 1_050_000) {
  return {
    id,
    enabled: true,
    protocol: "responses_native",
    context_window: contextWindow,
    max_output_tokens: 32_000,
    capabilities: { reasoning: true, tools: true },
  };
}

function bytes(paths) {
  return Object.fromEntries(
    ["config", "catalog", "modelMap"].map((key) => [
      key,
      fs.existsSync(paths[key]) ? fs.readFileSync(paths[key]) : null,
    ]),
  );
}

function assertBytesEqual(actual, expected) {
  for (const key of ["config", "catalog", "modelMap"]) {
    assert.deepEqual(actual[key], expected[key], key);
  }
}

test("reconcileModelState commits one validated config/catalog/modelMap state", async () => {
  const { paths, config } = fixture();

  const result = await reconcileModelState(paths, config, {
    authoritativeModels: [model()],
  });

  assert.equal(result.config.models.source_base_url, config.upstream.base_url);
  assert.equal(loadConfig(paths).models.available[0].context_window, 1_050_000);
  assert.equal(JSON.parse(fs.readFileSync(paths.catalog)).models[0].context_window, 1_050_000);
  assert.equal(
    JSON.parse(fs.readFileSync(paths.modelMap)).public_to_upstream["old-model"],
    "old-model",
  );
  assert.equal(validateModelState(paths, result.config), true);
});

test("reconcileModelState skips routing aliases without invented context limits", async () => {
  const { paths, config } = fixture();
  config.upstream.default_model = "Fast";

  const result = await reconcileModelState(paths, config, {
    authoritativeModels: [
      { id: "Fast" },
      model("ds/deepseek-v4-pro", 256_000),
      model("cx/gpt-5.6-sol", 1_050_000),
    ],
  });
  assert.equal(result.config.upstream.default_model, "cx/gpt-5.6-sol");
  assert.deepEqual(result.built.models.map((row) => row.slug), [
    "ds/deepseek-v4-pro",
    "cx/gpt-5.6-sol",
  ]);
});

test("invalid authoritative metadata leaves all active state bytes unchanged", async () => {
  const { paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);

  for (const [id, authoritativeModels, pattern] of [
    ["empty", [], /No usable model metadata/],
    ["undefined", [{ id: "undefined", context_window: undefined }], /context_window.*undefined|undefined.*context_window/],
    ["zero", [model("zero", 0)], /context_window.*zero|zero.*context_window/],
    ["negative", [model("negative", -1)], /context_window.*negative|negative.*context_window/],
    ["string", [model("string", "1050000")], /context_window.*string|string.*context_window/],
    ["nan", [model("nan", Number.NaN)], /context_window.*nan|nan.*context_window/],
    ["infinity", [model("infinity", Infinity)], /context_window.*infinity|infinity.*context_window/],
  ]) {
    await assert.rejects(
      () => reconcileModelState(paths, config, { authoritativeModels }),
      pattern,
      id,
    );
    assertBytesEqual(bytes(paths), before);
  }
});

test("all-disabled refresh cannot replace the last non-empty model state", async () => {
  const { paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);

  await assert.rejects(
    () => reconcileModelState(paths, config, {
      authoritativeModels: [{ ...model("disabled"), enabled: false }],
    }),
    /at least one usable model|No usable model metadata/,
  );

  assertBytesEqual(bytes(paths), before);
  assert.equal(validateModelState(paths, loadConfig(paths)), true);
});

test("invalid allow-list self-heals to a non-empty catalog and valid default model", async () => {
  const { paths, config } = fixture();
  config.models.enabled_ids = ["missing"];
  config.upstream.default_model = "missing";

  const result = await reconcileModelState(paths, config, {
    authoritativeModels: [model("model-a"), model("model-b")],
  });

  assert.equal(result.config.models.enabled_ids, null);
  assert.equal(result.config.upstream.default_model, "model-a");
  assert.deepEqual(result.built.models.map((row) => row.slug), ["model-a", "model-b"]);
});

test("stale interrupted transaction restores all previous active bytes", async () => {
  const { paths, config } = fixture();
  const { config: active } = await reconcileModelState(paths, config, {
    authoritativeModels: [model()],
  });
  const before = bytes(paths);
  const transactionDir = path.join(paths.stateDir, ".model-state-tx-stale");
  fs.mkdirSync(transactionDir);
  const targets = ["config", "catalog", "modelMap"].map((key, index) => {
    const backup = `backup-${index}`;
    fs.writeFileSync(path.join(transactionDir, backup), before[key]);
    fs.writeFileSync(paths[key], `{"corrupt":"${key}"}`);
    return { target: paths[key], existed: true, backup };
  });
  fs.writeFileSync(
    path.join(transactionDir, "transaction.json"),
    JSON.stringify({ phase: "prepared", targets }),
  );
  fs.writeFileSync(
    path.join(paths.stateDir, "model-state.lock"),
    JSON.stringify({ pid: 999_999_999, transaction_dir: transactionDir }),
  );

  assert.equal(validateModelState(paths, active), true);
  assertBytesEqual(bytes(paths), before);
  assert.equal(fs.existsSync(transactionDir), false);
});

test("committed transaction cleanup never rolls active state back", async () => {
  const { paths, config } = fixture();
  const { config: active } = await reconcileModelState(paths, config, {
    authoritativeModels: [model()],
  });
  const committed = bytes(paths);
  const transactionDir = path.join(paths.stateDir, ".model-state-tx-committed");
  fs.mkdirSync(transactionDir);
  const targets = ["config", "catalog", "modelMap"].map((key, index) => {
    const backup = `backup-${index}`;
    fs.writeFileSync(path.join(transactionDir, backup), Buffer.from(`{"old":"${key}"}`));
    return { target: paths[key], existed: true, backup };
  });
  fs.writeFileSync(
    path.join(transactionDir, "transaction.json"),
    JSON.stringify({ phase: "committed", targets }),
  );

  recoverModelState(paths);

  assertBytesEqual(bytes(paths), committed);
  assert.equal(validateModelState(paths, active), true);
  assert.equal(fs.existsSync(transactionDir), false);
});

test("failed recovery preserves transaction evidence and succeeds after repair", async () => {
  const { paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);
  const transactionDir = path.join(paths.stateDir, ".model-state-tx-retry");
  fs.mkdirSync(transactionDir);
  fs.writeFileSync(paths.catalog, '{"corrupt":true}');
  fs.writeFileSync(
    path.join(transactionDir, "transaction.json"),
    JSON.stringify({
      phase: "prepared",
      targets: [{ target: paths.catalog, existed: true, backup: "backup-0" }],
    }),
  );
  const lockFile = path.join(paths.stateDir, "model-state.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, transaction_dir: transactionDir }));

  assert.throws(() => recoverModelState(paths), /ENOENT/);
  assert.equal(fs.existsSync(transactionDir), true);
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(path.join(transactionDir, "backup-0"), before.catalog);
  recoverModelState(paths);

  assertBytesEqual(bytes(paths), before);
  assert.equal(fs.existsSync(transactionDir), false);
});

test("failed replacement rolls back config/catalog/modelMap as one unit", async () => {
  const { home, paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);
  const blockedParent = path.join(home, "blocked");
  fs.writeFileSync(blockedParent, "not a directory");

  await assert.rejects(
    () => reconcileModelState(
      { ...paths, modelMap: path.join(blockedParent, "model-map.json") },
      {
        ...config,
        upstream: { ...config.upstream, base_url: "https://new.example/v1" },
      },
      { authoritativeModels: [model("new-model", 128_000)] },
    ),
    /ENOTDIR/,
  );

  assertBytesEqual(bytes(paths), before);
});

test("preparation failure releases the model-state lock and transaction directory", async () => {
  const { home, paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);
  const directoryCatalog = path.join(home, "catalog-directory");
  fs.mkdirSync(directoryCatalog);

  await assert.rejects(
    () => reconcileModelState(
      { ...paths, catalog: directoryCatalog },
      config,
      { authoritativeModels: [model()] },
    ),
    /EISDIR|ENOTSUP|illegal operation on a directory|operation not supported/i,
  );

  assertBytesEqual(bytes(paths), before);
  assert.equal(fs.existsSync(path.join(paths.stateDir, "model-state.lock")), false);
  assert.deepEqual(
    fs.readdirSync(paths.stateDir).filter((name) => name.startsWith(".model-state-tx-")),
    [],
  );
});

test("failed upstream switch preserves the previous model state", async () => {
  const { paths, config } = fixture();
  await reconcileModelState(paths, config, { authoritativeModels: [model()] });
  const before = bytes(paths);
  const candidate = structuredClone(config);
  candidate.upstream.base_url = "https://new.example/v1";

  await assert.rejects(
    () => reconcileModelState(paths, config, {
      candidateConfig: candidate,
      fetchImpl: async () => { throw new Error("upstream unavailable"); },
    }),
    /upstream unavailable/,
  );

  assertBytesEqual(bytes(paths), before);
});

test("validateAuthoritativeModels rejects empty, duplicate, and invalid token limits", () => {
  assert.throws(() => validateAuthoritativeModels([]), /No usable model metadata/);
  assert.throws(
    () => validateAuthoritativeModels([model("same"), model("same")]),
    /Duplicate model id "same"/,
  );
  assert.throws(
    () => validateAuthoritativeModels([{ ...model(), max_output_tokens: Infinity }]),
    /max_output_tokens/,
  );
});

test("skips upstream aliases without invented context limits", () => {
  assert.deepEqual(validateAuthoritativeModels([
    { id: "Fast" },
    model("model-a", 1_050_000),
    { id: "Pro" },
    { id: "Image" },
  ]).map((row) => row.id), ["model-a"]);
  assert.throws(
    () => validateAuthoritativeModels([{ id: "Fast" }, { id: "Pro" }, { id: "Image" }]),
    /No usable model metadata available/,
  );
});

test("validateModelState detects catalog and model-map divergence", async () => {
  const { paths, config } = fixture();
  const { config: active } = await reconcileModelState(paths, config, {
    authoritativeModels: [model()],
  });

  fs.writeFileSync(paths.catalog, JSON.stringify({ models: [] }));
  assert.throws(() => validateModelState(paths, active), /catalog.*inconsistent/i);

  await reconcileModelState(paths, active, { authoritativeModels: [model()] });
  fs.writeFileSync(paths.modelMap, JSON.stringify({ namespace: "9codex" }));
  assert.throws(() => validateModelState(paths, active), /model map.*inconsistent/i);
});
