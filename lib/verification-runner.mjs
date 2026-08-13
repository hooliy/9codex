import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sanitize(value, secrets) {
  let text = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function safeName(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 120);
}

function expandSafeArgument(value) {
  return String(value).replaceAll("$(id -u)", String(process.getuid?.() ?? ""));
}

function commandRisk(command) {
  const [file = "", ...args] = command.map((value) => String(value).toLowerCase());
  const executable = path.basename(file);
  const joined = args.join(" ");
  if (["rm", "rmdir", "del", "erase", "shutdown", "reboot"].includes(executable)) return "destructive local command";
  if (executable === "git" && args[0] === "push") return "remote repository mutation";
  if (["npm", "pnpm", "yarn", "cargo", "gem"].includes(executable) && args[0] === "publish") return "package publication";
  if (executable === "terraform" && ["apply", "destroy", "import"].includes(args[0])) return "infrastructure mutation";
  if (executable === "kubectl" && ["apply", "create", "delete", "replace", "patch", "scale", "drain"].includes(args[0])) return "cluster mutation";
  if (executable === "helm" && ["install", "upgrade", "uninstall", "rollback"].includes(args[0])) return "cluster release mutation";
  if (
    /(?:^|\s)(?:deploy|publish|release|destroy|delete-stack|db push|migrate deploy|--prod|production)(?:\s|$)/
      .test(`${executable} ${joined}`)
  ) return "production or irreversible operation";
  return null;
}

function runProcess(file, args, options) {
  return new Promise((resolve) => {
    const child = (options.spawn || spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ exitCode: null, stdout, stderr, error }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      finish({ exitCode: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    timer.unref();
  });
}

export async function runVerification(criteria, options = {}) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error("verification criteria must be a non-empty array");
  }
  const artifactDir = options.artifactDir;
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDir, 0o700);
  const evidence = [];

  for (const [index, criterion] of criteria.entries()) {
    if (
      !criterion
      || typeof criterion.id !== "string"
      || !Array.isArray(criterion.command)
      || criterion.command.length === 0
      || criterion.command.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      throw new Error(`criterion ${index} must contain id and command argv`);
    }
    const [file, ...rawArgs] = criterion.command;
    const args = rawArgs.map(expandSafeArgument);
    const risk = commandRisk(criterion.command);
    if (risk) {
      throw Object.assign(new Error(`unsafe verification command rejected: ${risk}`), {
        code: "unsafe_command",
        command: criterion.command,
      });
    }
    const startedAt = new Date().toISOString();
    const result = await runProcess(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      spawn: options.spawn,
      timeoutMs: criterion.timeout_ms || options.timeoutMs || 120_000,
    });
    const output = sanitize(
      `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`,
      options.secrets || [],
    );
    const outputPath = path.join(
      artifactDir,
      `${String(index + 1).padStart(3, "0")}-${safeName(criterion.id)}.log`,
    );
    fs.writeFileSync(outputPath, output, { mode: 0o600 });
    fs.chmodSync(outputPath, 0o600);
    const passed = !result.timedOut && result.exitCode === (criterion.expected_exit_code ?? 0);
    evidence.push({
      type: criterion.type || "command",
      source: "verification_runner",
      criterion_id: criterion.id,
      command: criterion.command,
      exit_code: result.exitCode,
      signal: result.signal || null,
      timed_out: Boolean(result.timedOut),
      result: passed ? "passed" : "failed",
      output_path: outputPath,
      content_hash: crypto.createHash("sha256").update(output).digest("hex"),
      started_at: startedAt,
      created_at: new Date().toISOString(),
    });
    if (!passed && options.stopOnFailure !== false) break;
  }

  return {
    result: evidence.length === criteria.length && evidence.every((row) => row.result === "passed")
      ? "passed"
      : "failed",
    evidence,
  };
}
