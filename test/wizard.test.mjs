import assert from "node:assert/strict";
import test from "node:test";

import { askModelSelection, normalizeBaseUrl } from "../lib/wizard.mjs";

test("normalizes relay base URLs without embedding a package default", () => {
  assert.equal(
    normalizeBaseUrl("router.example.com/v1/"),
    "https://router.example.com/v1",
  );
  assert.equal(
    normalizeBaseUrl("http://192.0.2.10:20128/v1"),
    "http://192.0.2.10:20128/v1",
  );
  assert.throws(() => normalizeBaseUrl(""), /不能为空/);
});

test("maps interactive model numbers to upstream model ids", async () => {
  const rl = { question: async () => "1, 3，1" };
  const selected = await askModelSelection(rl, [
    { id: "model-a" },
    { id: "model-b" },
    { id: "vendor/model-c" },
  ]);

  assert.deepEqual(selected, ["model-a", "vendor/model-c"]);
});

test("supports distinct empty selections for init and sync", async () => {
  const rl = { question: async () => "" };
  const models = [{ id: "model-a" }];

  assert.equal(await askModelSelection(rl, models), null);
  assert.deepEqual(
    await askModelSelection(rl, models, { emptySelection: ["model-a"] }),
    ["model-a"],
  );
});
