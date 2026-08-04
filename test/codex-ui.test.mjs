import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelPickerOverrideScript,
  enableModelPicker,
  reserveLoopbackPort,
} from "../lib/codex-ui.mjs";

test("renderer override changes only the Codex model allow-list filter", () => {
  const source = buildModelPickerOverrideScript();

  assert.match(source, /107580212/);
  assert.match(source, /use_hidden_models/);
  assert.match(source, /false/);
  assert.match(source, /previousAdapter/);
  assert.doesNotMatch(source, /available_models\s*:/);
  assert.doesNotMatch(source, /localStorage/);
});

test("model picker integration patches every main renderer and verifies the override", async () => {
  const evaluated = [];
  const result = await enableModelPicker({
    port: 53111,
    listTargets: async () => [
      { id: "overlay", type: "page", url: "file:///avatar-overlay.html" },
      { id: "main", type: "page", url: "file:///index.html" },
    ],
    evaluateTarget: async (target, source) => {
      evaluated.push({ target, source });
      return { applied: true, useHiddenModels: false };
    },
  });

  assert.deepEqual(evaluated.map(({ target }) => target.id), ["main"]);
  assert.match(evaluated[0].source, /107580212/);
  assert.deepEqual(result, {
    connected: true,
    patched: 1,
    verified: true,
  });
});

test("model picker integration fails closed when the expected Statsig hook is unavailable", async () => {
  await assert.rejects(
    enableModelPicker({
      port: 53112,
      listTargets: async () => [{ id: "main", type: "page", url: "file:///index.html" }],
      evaluateTarget: async () => ({ applied: false, reason: "statsig-unavailable" }),
    }),
    /model picker override was not applied/,
  );
});

test("reserves a loopback debugging port before releasing the temporary server", async () => {
  const port = await reserveLoopbackPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);
});
