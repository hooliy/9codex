import crypto from "node:crypto";

const CRITERION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "command"],
  properties: {
    id: { type: "string", minLength: 1 },
    command: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
  },
};

const IMPACT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workItemId", "action"],
  properties: {
    workItemId: { type: "string", minLength: 1 },
    action: { type: "string", enum: ["rework", "revalidate", "stale", "canceled"] },
  },
};

export const DEMAND_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "reference"],
  properties: {
    kind: { type: "string", minLength: 1 },
    reference: { type: "string", minLength: 1 },
    fingerprint: { type: "string", minLength: 1 },
    metadata: { type: "object" },
  },
};

export const DEMAND_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "questions", "requirements"],
  properties: {
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    requirements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key", "requirementId", "title", "normalizedRequirement", "impactSummary",
          "acceptanceCriteria", "impactActions", "workItems",
        ],
        properties: {
          key: { type: "string", minLength: 1 },
          requirementId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          title: { type: "string", minLength: 1 },
          normalizedRequirement: { type: "string", minLength: 1 },
          impactSummary: { type: "string" },
          acceptanceCriteria: { type: "array", items: CRITERION_SCHEMA },
          impactActions: {
            type: "array",
            items: IMPACT_ACTION_SCHEMA,
          },
          workItems: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "key", "title", "description", "priority", "writeSet", "readSet",
                "resourceLocks", "dependencies", "acceptanceCriteria",
              ],
              properties: {
                key: { type: "string", minLength: 1 },
                title: { type: "string", minLength: 1 },
                description: { type: "string" },
                priority: { type: "integer" },
                writeSet: { type: "array", items: { type: "string" } },
                readSet: { type: "array", items: { type: "string" } },
                resourceLocks: { type: "array", items: { type: "string" } },
                dependencies: { type: "array", items: { type: "string" } },
                acceptanceCriteria: { type: "array", minItems: 1, items: CRITERION_SCHEMA },
              },
            },
          },
        },
      },
    },
  },
};

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value.trim();
}

function plainObject(value, name) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return structuredClone(value);
}

function impactAction(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`requirements[].impactActions[${index}] must be an object`);
  }
  const action = requireText(value.action, `requirements[].impactActions[${index}].action`);
  if (!["rework", "revalidate", "stale", "canceled"].includes(action)) {
    throw new TypeError(`requirements[].impactActions[${index}].action is invalid`);
  }
  return {
    workItemId: requireText(value.workItemId, `requirements[].impactActions[${index}].workItemId`),
    action,
  };
}

function impactActions(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = impactAction(entry, index);
    if (seen.has(normalized.workItemId)) {
      throw new TypeError(`duplicate impact action workItemId: ${normalized.workItemId}`);
    }
    seen.add(normalized.workItemId);
    return normalized;
  });
}

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function criterion(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const id = requireText(value.id, `${name}.id`);
  if (!Array.isArray(value.command) || value.command.length === 0) {
    throw new TypeError(`${name}.command must be a non-empty argv array`);
  }
  return { id, command: value.command.map((part, index) => requireText(part, `${name}.command[${index}]`)) };
}

function workItem(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`requirements[].workItems[${index}] must be an object`);
  }
  return {
    key: requireText(value.key || `work-${index + 1}`, `requirements[].workItems[${index}].key`),
    title: requireText(value.title, `requirements[].workItems[${index}].title`),
    description: typeof value.description === "string" ? value.description : "",
    priority: Number.isInteger(value.priority) ? value.priority : 0,
    writeSet: Array.isArray(value.writeSet) ? value.writeSet.map(String) : [],
    readSet: Array.isArray(value.readSet) ? value.readSet.map(String) : [],
    resourceLocks: Array.isArray(value.resourceLocks) ? value.resourceLocks.map(String) : [],
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.map(String) : [],
    acceptanceCriteria: (value.acceptanceCriteria || []).map((entry, criterionIndex) => (
      criterion(entry, `requirements[].workItems[${index}].acceptanceCriteria[${criterionIndex}]`)
    )),
  };
}

export function normalizeDemandProposal(value, fallbackContent = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("proposal must be an object");
  }
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    throw new TypeError("proposal.requirements must contain at least one requirement");
  }
  const keys = new Set();
  const requirements = value.requirements.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`proposal.requirements[${index}] must be an object`);
    }
    const key = requireText(entry.key || `requirement-${index + 1}`, `proposal.requirements[${index}].key`);
    if (keys.has(key)) throw new TypeError(`duplicate requirement key: ${key}`);
    keys.add(key);
    const workItems = (entry.workItems || []).map(workItem);
    if (workItems.length === 0) throw new TypeError(`proposal.requirements[${index}].workItems is required`);
    const workKeys = new Set();
    for (const item of workItems) {
      if (workKeys.has(item.key)) throw new TypeError(`duplicate work item key in ${key}: ${item.key}`);
      workKeys.add(item.key);
    }
    return {
      key,
      requirementId: entry.requirementId == null ? null : requireText(entry.requirementId, `proposal.requirements[${index}].requirementId`),
      title: requireText(entry.title, `proposal.requirements[${index}].title`),
      normalizedRequirement: requireText(
        entry.normalizedRequirement || fallbackContent,
        `proposal.requirements[${index}].normalizedRequirement`,
      ),
      impactSummary: typeof entry.impactSummary === "string" ? entry.impactSummary : "",
      acceptanceCriteria: (entry.acceptanceCriteria || []).map((criterionValue, criterionIndex) => (
        criterion(criterionValue, `proposal.requirements[${index}].acceptanceCriteria[${criterionIndex}]`)
      )),
      impactActions: impactActions(
        entry.impactActions ?? [],
        `proposal.requirements[${index}].impactActions`,
      ),
      workItems,
    };
  });
  return {
    summary: typeof value.summary === "string" ? value.summary : requirements.map((entry) => entry.title).join("；"),
    questions: Array.isArray(value.questions) ? value.questions.map(String).filter(Boolean) : [],
    requirements,
  };
}

export function normalizeDemandInput(input) {
  const content = requireText(input?.content, "content");
  const sourceMessageId = requireText(input?.sourceMessageId, "sourceMessageId");
  const sourceValue = plainObject(input.source, "source");
  const kind = requireText(sourceValue.kind || "message", "source.kind");
  const reference = requireText(sourceValue.reference || sourceMessageId, "source.reference");
  const metadata = plainObject(sourceValue.metadata, "source.metadata");
  const source = {
    kind,
    reference,
    fingerprint: sourceValue.fingerprint
      ? requireText(sourceValue.fingerprint, "source.fingerprint")
      : fingerprint({ kind, reference, content }),
    metadata,
  };
  return {
    ...input,
    content,
    sourceMessageId,
    source,
    proposal: input.proposal == null ? null : normalizeDemandProposal(input.proposal, content),
  };
}
