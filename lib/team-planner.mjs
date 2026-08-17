import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEMAND_PROPOSAL_SCHEMA } from "./demand-intake.mjs";
import { assertRuntimeKind } from "./runtime-driver.mjs";

function safeEnvironment(environment = process.env) {
  const allowed = [
    "HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot", "CODEX_HOME",
  ];
  return Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]));
}

function instruction(input) {
  return [
    "Act only as a software task planner. Do not edit files or run tools.",
    `Return only JSON matching this schema: ${JSON.stringify(DEMAND_PROPOSAL_SCHEMA)}`,
    "Treat one input as a demand batch: create multiple requirements only when they have independent outcomes or acceptance.",
    "For changes, bind the proposal to an existing requirementId. Never silently overwrite another requirement.",
    "Create the minimum independently verifiable WorkItem DAG.",
    "Use repository-relative writeSet/readSet globs. Never use ** unless the request truly changes the whole repository.",
    "Use argv arrays for acceptance commands; no shell strings.",
    `Classification: ${JSON.stringify(input.classification)}`,
    `Existing requirements: ${JSON.stringify(input.existingRequirements || [])}`,
    `Existing work: ${JSON.stringify((input.existingWorkItems || []).map((row) => ({ id: row.id, title: row.title, status: row.status })))}`,
    `User demand:\n${input.content}`,
  ].join("\n\n");
}

function runtimeFor(options, runtimeKind) {
  if (runtimeKind === "codex") return options.codexRuntime;
  if (runtimeKind === "deepseek-harness") return options.harnessRuntime;
  assertRuntimeKind(runtimeKind);
}

function plannerText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "run.output") continue;
    const data = event.data || {};
    const text = data.type === "run.output"
      ? data.text
      : data.type === "item.completed" && data.item?.type === "agent_message"
        ? data.item.text
        : null;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  throw new Error("planner returned no JSON");
}

export function createTeamPlanner(options = {}) {
  if (!options.codexRuntime) throw new TypeError("codexRuntime is required");
  if (!options.harnessRuntime) throw new TypeError("harnessRuntime is required");
  return async (input) => {
    const runtimeKind = assertRuntimeKind(input?.taskGroup?.runtime_kind);
    const runtime = runtimeFor(options, runtimeKind);
    let directory;
    let worker;
    try {
      const env = safeEnvironment(options.env);
      if (runtimeKind === "deepseek-harness") delete env.CODEX_HOME;
      const workerOptions = {
        cwd: input.taskGroup.workspace,
        sandbox: "read-only",
        ignoreUserConfig: false,
        env,
      };
      if (runtimeKind === "codex") {
        directory = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), "9codex-planner-"));
        const schemaPath = path.join(directory, "schema.json");
        fs.writeFileSync(schemaPath, `${JSON.stringify(DEMAND_PROPOSAL_SCHEMA)}\n`, { mode: 0o600 });
        workerOptions.extraArgs = ["--output-schema", schemaPath];
      }
      worker = runtime.createWorker(instruction(input), workerOptions);
      const result = await runtime.waitWorker(worker, { timeoutMs: options.timeoutMs || 180_000 });
      if (!result.ok) throw new Error(`planner exited with ${result.code}`);
      return JSON.parse(plannerText(runtime.readEvents(worker)));
    } finally {
      if (worker?.sessionId || worker?.threadId) {
        try { await runtime.closeWorker(worker); } catch {}
      }
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
