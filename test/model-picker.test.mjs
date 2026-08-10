import assert from "node:assert/strict";
import test from "node:test";

import {
  applyModelPickerPolicy,
  buildModelPickerPolicyScript,
  reserveLoopbackPort,
} from "../lib/model-picker.mjs";

test("model picker policy exposes custom catalog models without reloading Codex", () => {
  const source = buildModelPickerPolicyScript();

  assert.match(source, /107580212/);
  assert.match(source, /use_hidden_models/);
  assert.match(source, /use_hidden_models:\s*false/);
  assert.doesNotMatch(source, /location\.reload/);
});

test("model picker policy patches only the main renderer and verifies visibility", async () => {
  const evaluated = [];
  const result = await applyModelPickerPolicy({
    port: 53111,
    listTargets: async () => [
      { id: "overlay", type: "page", url: "file:///avatar-overlay.html" },
      { id: "worker", type: "service_worker", url: "file:///worker.js" },
      { id: "main", type: "page", url: "file:///index.html" },
    ],
    evaluateTarget: async (target, source) => {
      evaluated.push({ target, source });
      return { applied: true, useHiddenModels: false };
    },
  });

  assert.deepEqual(evaluated.map(({ target }) => target.id), ["main"]);
  assert.deepEqual(result, { connected: true, patched: 1, verified: true });
});

test("model picker policy reports an unavailable Statsig policy", async () => {
  await assert.rejects(
    applyModelPickerPolicy({
      port: 53112,
      listTargets: async () => [{ id: "main", type: "page", url: "file:///index.html" }],
      evaluateTarget: async () => ({ applied: false, reason: "statsig-unavailable" }),
    }),
    /model picker policy was not applied/,
  );
});

test("model picker policy reserves a loopback port", async () => {
  const port = await reserveLoopbackPort();

  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0 && port <= 65535, true);
});
