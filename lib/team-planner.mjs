import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requirement", "workItems"],
  properties: {
    requirement: {
      type: "object",
      additionalProperties: false,
      required: ["title", "normalizedRequirement", "acceptanceCriteria", "impactSummary"],
      properties: {
        title: { type: "string" },
        normalizedRequirement: { type: "string" },
        impactSummary: { type: "string" },
        acceptanceCriteria: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "command"],
            properties: {
              id: { type: "string" },
              command: { type: "array", minItems: 1, items: { type: "string" } },
            },
          },
        },
      },
    },
    workItems: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key", "title", "description", "writeSet", "readSet",
          "resourceLocks", "dependencies", "acceptanceCriteria",
        ],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          writeSet: { type: "array", items: { type: "string" } },
          readSet: { type: "array", items: { type: "string" } },
          resourceLocks: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "command"],
              properties: {
                id: { type: "string" },
                command: { type: "array", minItems: 1, items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

function safeEnvironment(environment = process.env) {
  const allowed = [
    "HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot",
  ];
  return Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]));
}

function instruction(input) {
  return [
    "Act only as a software task planner. Do not edit files or run tools.",
    "Return JSON matching the supplied schema.",
    "Create the minimum independently verifiable WorkItem DAG.",
    "Use repository-relative writeSet/readSet globs. Never use ** unless the request truly changes the whole repository.",
    "Use argv arrays for acceptance commands; no shell strings.",
    `Classification: ${JSON.stringify(input.classification)}`,
    `Current requirement: ${JSON.stringify(input.currentRequirement || null)}`,
    `Existing work: ${JSON.stringify((input.existingWorkItems || []).map((row) => ({ id: row.id, title: row.title, status: row.status })))}`,
    `User demand:\n${input.content}`,
  ].join("\n\n");
}

export function createTeamPlanner(options = {}) {
  const adapter = options.adapter;
  if (!adapter) throw new TypeError("adapter is required");
  return async (input) => {
    const directory = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), "9codex-planner-"));
    const schemaPath = path.join(directory, "schema.json");
    fs.writeFileSync(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA)}\n`, { mode: 0o600 });
    let worker;
    try {
      worker = adapter.createWorker(instruction(input), {
        cwd: input.taskGroup.workspace,
        sandbox: "read-only",
        ignoreUserConfig: false,
        extraArgs: ["--output-schema", schemaPath],
        env: safeEnvironment(options.env),
      });
      const result = await adapter.waitWorker(worker, { timeoutMs: options.timeoutMs || 180_000 });
      if (!result.ok) throw new Error(`planner exited with ${result.code}`);
      const events = adapter.readEvents(worker);
      const text = events.findLast((event) => event?.item?.type === "agent_message")?.item?.text;
      if (!text) throw new Error("planner returned no JSON");
      return JSON.parse(text);
    } finally {
      if (worker?.sessionId || worker?.threadId) {
        try { await adapter.closeWorker(worker); } catch {}
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
