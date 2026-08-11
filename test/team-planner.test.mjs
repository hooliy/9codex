import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTeamPlanner } from "../lib/team-planner.mjs";

test("planner uses read-only structured Codex output and archives its session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-planner-test-"));
  const calls = [];
  const worker = { id: "planner", sessionId: "planner-thread" };
  const adapter = {
    createWorker(prompt, options) {
      calls.push({ prompt, options });
      return worker;
    },
    async waitWorker() { return { ok: true, code: 0 }; },
    readEvents() {
      return [{
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            requirement: {
              title: "Login",
              normalizedRequirement: "Implement login",
              impactSummary: "new feature",
              acceptanceCriteria: [{ id: "test", command: ["npm", "test"] }],
            },
            workItems: [{
              key: "auth",
              title: "Auth",
              description: "Implement auth",
              writeSet: ["lib/auth.mjs"],
              readSet: ["lib/config.mjs"],
              resourceLocks: [],
              dependencies: [],
              acceptanceCriteria: [{ id: "test", command: ["npm", "test"] }],
            }],
          }),
        },
      }];
    },
    async closeWorker(value) { calls.push({ closed: value.id }); },
  };
  const planner = createTeamPlanner({ adapter, tempRoot: root, env: { HOME: "/home", SECRET: "no" } });
  const plan = await planner({
    content: "Implement login",
    classification: { type: "new_requirement" },
    taskGroup: { workspace: root },
    existingWorkItems: [],
  });

  assert.equal(plan.workItems[0].writeSet[0], "lib/auth.mjs");
  assert.equal(calls[0].options.sandbox, "read-only");
  assert.equal(calls[0].options.env.SECRET, undefined);
  assert.equal(calls[0].options.extraArgs[0], "--output-schema");
  assert.equal(fs.existsSync(calls[0].options.extraArgs[1]), false);
  assert.deepEqual(calls.at(-1), { closed: "planner" });
  fs.rmSync(root, { recursive: true, force: true });
});
