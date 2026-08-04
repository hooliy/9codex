import { spawn } from "node:child_process";

const NPM_PACKAGE = "@hooliy/9codex";

export class UpdateError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "UpdateError";
    this.code = code;
  }
}

export function validateUpdateRequest(request, policy) {
  const keys = Object.keys(request || {});
  const normalizedRegistry = String(request?.registry || "").replace(/\/$/, "");
  const policyRegistry = String(policy?.npm_registry || "").replace(/\/$/, "");
  if (
    policy?.enabled === false ||
    request?.package !== NPM_PACKAGE ||
    typeof request?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request.version) ||
    request?.channel !== policy?.channel ||
    normalizedRegistry !== policyRegistry ||
    keys.some((key) => !["package", "version", "channel", "registry"].includes(key))
  ) {
    throw new UpdateError("invalid_update_request", "Update request violates local policy");
  }
  return {
    package: NPM_PACKAGE,
    version: request.version,
    channel: request.channel,
    registry: normalizedRegistry,
  };
}

function installDefault(spec, registry) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["install", "-g", spec, "--registry", registry], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new UpdateError("npm_install_failed", `npm install exited with ${status}`));
    });
  });
}

export async function runStagedUpdate(request, options) {
  const validated = validateUpdateRequest(request, options.policy);
  const install = options.install || installDefault;
  const restart = options.restart;
  const health = options.health;
  const targetSpec = `${NPM_PACKAGE}@${validated.version}`;
  const rollbackSpec = `${NPM_PACKAGE}@${options.currentVersion}`;
  await install(targetSpec, validated.registry);
  await restart();
  if (await health()) {
    return { updated: true, version: validated.version, rolled_back: false };
  }
  await install(rollbackSpec, validated.registry);
  await restart();
  throw new UpdateError("update_health_failed", "Updated service failed health check and was rolled back");
}
