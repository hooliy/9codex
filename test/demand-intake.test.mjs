import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDemandInput,
  normalizeDemandProposal,
} from "../lib/demand-intake.mjs";

function workItem(key = "implementation") {
  return {
    key,
    title: "实现",
    description: "完成需求",
    priority: 0,
    writeSet: ["lib/feature.mjs"],
    readSet: [],
    resourceLocks: [],
    dependencies: [],
    acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
  };
}

function requirement(key = "requirement-1") {
  return {
    key,
    requirementId: null,
    title: "功能",
    normalizedRequirement: "实现功能",
    impactSummary: "新增功能",
    acceptanceCriteria: [{ id: "tests", command: ["npm", "test"] }],
    impactActions: {},
    workItems: [workItem()],
  };
}

test("normalizes a message source with a stable content fingerprint", () => {
  const input = {
    sourceMessageId: "message-1",
    content: "实现登录",
  };

  const first = normalizeDemandInput(input);
  const second = normalizeDemandInput(input);

  assert.deepEqual(first.source, second.source);
  assert.equal(first.source.kind, "message");
  assert.equal(first.source.reference, "message-1");
  assert.match(first.source.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("preserves an explicit document source and metadata", () => {
  const normalized = normalizeDemandInput({
    sourceMessageId: "message-2",
    content: "读取计划",
    source: {
      kind: "document",
      reference: "/tmp/plan.docx",
      fingerprint: "sha256:abc",
      metadata: { page: 2 },
    },
  });

  assert.deepEqual(normalized.source, {
    kind: "document",
    reference: "/tmp/plan.docx",
    fingerprint: "sha256:abc",
    metadata: { page: 2 },
  });
});

test("normalizes multiple independent requirements", () => {
  const proposal = normalizeDemandProposal({
    summary: "两个结果",
    questions: [],
    requirements: [
      requirement("frontend"),
      { ...requirement("backend"), workItems: [workItem("api")] },
    ],
  });

  assert.deepEqual(proposal.requirements.map((entry) => entry.key), ["frontend", "backend"]);
  assert.equal(proposal.requirements[1].workItems[0].key, "api");
});

test("rejects duplicate requirement keys", () => {
  assert.throws(
    () => normalizeDemandProposal({
      summary: "",
      questions: [],
      requirements: [requirement("same"), requirement("same")],
    }),
    /duplicate requirement key: same/,
  );
});

test("rejects requirements without work items", () => {
  assert.throws(
    () => normalizeDemandProposal({
      summary: "",
      questions: [],
      requirements: [{ ...requirement(), workItems: [] }],
    }),
    /workItems is required/,
  );
});

test("rejects shell command strings at the trust boundary", () => {
  assert.throws(
    () => normalizeDemandProposal({
      summary: "",
      questions: [],
      requirements: [{
        ...requirement(),
        workItems: [{
          ...workItem(),
          acceptanceCriteria: [{ id: "tests", command: "npm test" }],
        }],
      }],
    }),
    /command must be a non-empty argv array/,
  );
});
