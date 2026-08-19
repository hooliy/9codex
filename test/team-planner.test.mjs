import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTeamPlanner } from "../lib/team-planner.mjs";
import { DEMAND_PROPOSAL_SCHEMA } from "../lib/demand-intake.mjs";

function plannedOutput() {
  return JSON.stringify({
    summary: "Implement login",
    questions: [],
    requirements: [{
      key: "login",
      requirementId: null,
      title: "Login",
      normalizedRequirement: "Implement login",
      impactSummary: "new feature",
      acceptanceCriteria: [{ id: "test", command: ["npm", "test"] }],
      impactActions: [],
      workItems: [{
        key: "auth",
        title: "Auth",
        description: "Implement auth",
        priority: 0,
        writeSet: ["lib/auth.mjs"],
        readSet: ["lib/config.mjs"],
        resourceLocks: [],
        dependencies: [],
        acceptanceCriteria: [{ id: "test", command: ["npm", "test"] }],
      }],
    }],
  });
}

function assertClosedStructuredOutputSchema(schema, location = "$") {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${location} must be closed`);
    const properties = Object.keys(schema.properties || {}).sort();
    const required = [...(schema.required || [])].sort();
    assert.deepEqual(required, properties, `${location} must require every property`);
    for (const [key, value] of Object.entries(schema.properties || {})) {
      assertClosedStructuredOutputSchema(value, `${location}.${key}`);
    }
  }
  if (schema.items) assertClosedStructuredOutputSchema(schema.items, `${location}[]`);
  for (const [index, value] of (schema.anyOf || []).entries()) {
    assertClosedStructuredOutputSchema(value, `${location}.anyOf[${index}]`);
  }
}

test("Demand Proposal schema is closed for Codex Structured Outputs", () => {
  assertClosedStructuredOutputSchema(DEMAND_PROPOSAL_SCHEMA);
  const impactActions = DEMAND_PROPOSAL_SCHEMA
    .properties.requirements.items.properties.impactActions;
  assert.equal(impactActions.type, "array");
  assert.equal(impactActions.items.additionalProperties, false);
});

test("Codex project planner uses the Codex Runtime with read-only structured output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-planner-test-"));
  const calls = [];
  const worker = { id: "planner", sessionId: "planner-thread" };
  const codexRuntime = {
    createWorker(prompt, options) {
      calls.push({ prompt, options });
      return worker;
    },
    async waitWorker() { return { ok: true, code: 0 }; },
    readEvents() {
      return [
        {
          type: "run.output",
          runtime_kind: "codex",
          data: {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: plannedOutput(),
            },
          },
        },
        {
          type: "run.output",
          runtime_kind: "codex",
          data: {
            type: "adapter.stderr",
            text: "2026-08-14T05:28:44Z diagnostic",
          },
        },
      ];
    },
    async closeWorker(value) { calls.push({ closed: value.id }); },
  };
  const planner = createTeamPlanner({
    codexRuntime,
    harnessRuntime: {
      createWorker() { throw new Error("Harness Runtime must not be used"); },
    },
    tempRoot: root,
    env: { HOME: "/home", CODEX_HOME: "/codex-home", SECRET: "no" },
  });
  const plan = await planner({
    content: "Implement login",
    classification: { type: "new_requirement" },
    taskGroup: { workspace: root, runtime_kind: "codex" },
    existingWorkItems: [],
  });

  assert.equal(plan.requirements[0].workItems[0].writeSet[0], "lib/auth.mjs");
  assert.equal(calls[0].options.sandbox, "read-only");
  assert.equal(calls[0].options.env.SECRET, undefined);
  assert.equal(calls[0].options.env.CODEX_HOME, "/codex-home");
  assert.equal(calls[0].options.extraArgs[0], "--output-schema");
  assert.equal(fs.existsSync(calls[0].options.extraArgs[1]), false);
  assert.deepEqual(calls.at(-1), { closed: "planner" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("Harness project planner uses only the Harness Runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-harness-planner-test-"));
  const calls = [];
  const worker = { id: "harness-planner", sessionId: "harness-session" };
  const planner = createTeamPlanner({
    codexRuntime: {
      createWorker() { throw new Error("Codex Runtime must not be used"); },
    },
    harnessRuntime: {
      createWorker(prompt, options) {
        calls.push(["create", prompt, options]);
        return worker;
      },
      async waitWorker(value) {
        calls.push(["wait", value.id]);
        return { ok: true, code: 0 };
      },
      readEvents(value) {
        calls.push(["events", value.id]);
        return [{
          type: "run.output",
          runtime_kind: "deepseek-harness",
          data: { type: "run.output", text: plannedOutput() },
        }];
      },
      async closeWorker(value) {
        calls.push(["close", value.id]);
      },
    },
    tempRoot: root,
    env: { HOME: "/home", CODEX_HOME: "/codex-home", SECRET: "no" },
  });

  const plan = await planner({
    content: "Implement login",
    classification: { type: "new_requirement" },
    taskGroup: { workspace: root, runtime_kind: "deepseek-harness" },
    existingWorkItems: [],
  });

  assert.equal(plan.requirements[0].title, "Login");
  assert.match(calls[0][1], /"required":\["summary","questions","requirements"\]/);
  assert.match(calls[0][1], /"requirementId":\{"anyOf":/);
  assert.equal(calls[0][2].extraArgs, undefined);
  assert.equal(calls[0][2].env.SECRET, undefined);
  assert.equal(calls[0][2].env.CODEX_HOME, undefined);
  assert.deepEqual(calls.slice(1), [
    ["wait", "harness-planner"],
    ["events", "harness-planner"],
    ["close", "harness-planner"],
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
