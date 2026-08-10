import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_PACKAGE = "@hooliy/9codex";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CURRENT_PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function compareVersions(left, right) {
  const [leftCore, leftPre] = left.split("-", 2);
  const [rightCore, rightPre] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  if (leftPre == null) return rightPre == null ? 0 : 1;
  if (rightPre == null) return -1;
  return leftPre.localeCompare(rightPre, "en", { numeric: true });
}

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
    !SEMVER.test(request.version) ||
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

export async function resolveLatestVersion(policy, options = {}) {
  if (policy?.enabled === false) {
    throw new UpdateError("updates_disabled", "Package updates are disabled");
  }
  const registry = String(policy?.npm_registry || "").replace(/\/$/, "");
  if (!registry) throw new UpdateError("invalid_registry", "No npm registry is configured");
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${registry}/${encodeURIComponent(NPM_PACKAGE)}`, {
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  });
  if (!response.ok) {
    throw new UpdateError("update_lookup_failed", `npm registry returned HTTP ${response.status}`);
  }
  const metadata = await response.json();
  const tag = policy.channel === "stable" ? "latest" : policy.channel;
  const version = metadata?.["dist-tags"]?.[tag];
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new UpdateError("invalid_registry_version", `npm registry has no valid ${tag} version`);
  }
  return version;
}

export function npmSpawnOptions(platform = process.platform) {
  return {
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  };
}

export function npmInstallCommand(spec, registry, options = {}) {
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const packageRoot = pathApi.resolve(options.packageRoot || CURRENT_PACKAGE_ROOT);
  let nodeModules = packageRoot;
  while (pathApi.basename(nodeModules) !== "node_modules") {
    const parent = pathApi.dirname(nodeModules);
    if (parent === nodeModules) throw new UpdateError("invalid_installation", "Cannot resolve active npm prefix");
    nodeModules = parent;
  }
  const nodeModulesParent = pathApi.dirname(nodeModules);
  const prefix = platform === "win32" || pathApi.basename(nodeModulesParent) !== "lib"
    ? nodeModulesParent
    : pathApi.dirname(nodeModulesParent);
  const npmCli = platform === "win32"
    ? pathApi.join(pathApi.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : pathApi.resolve(pathApi.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return {
    file: execPath,
    cliPath: pathApi.join(nodeModules, "@hooliy", "9codex", "bin", "9codex.mjs"),
    args: [
      npmCli,
      "install",
      "-g",
      spec,
      "--prefix",
      prefix,
      "--registry",
      registry,
    ],
  };
}

function installDefault(spec, registry, options) {
  const command = npmInstallCommand(spec, registry, options);
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.file,
      command.args,
      npmSpawnOptions(),
    );
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve({ cliPath: command.cliPath });
      else reject(new UpdateError("npm_install_failed", `npm install exited with ${status}`));
    });
  });
}

export async function runStagedUpdate(request, options) {
  const validated = validateUpdateRequest(request, options.policy);
  const install = options.install || ((spec, registry) => installDefault(spec, registry, options));
  const activate = options.activate;
  const health = options.health;
  if (typeof activate !== "function") {
    throw new UpdateError("missing_activation", "Updated package cannot be activated");
  }
  if (compareVersions(validated.version, options.currentVersion) <= 0) {
    return { updated: false, version: options.currentVersion, rolled_back: false };
  }
  const targetSpec = `${NPM_PACKAGE}@${validated.version}`;
  const rollbackSpec = `${NPM_PACKAGE}@${options.currentVersion}`;
  const targetInstallation = await install(targetSpec, validated.registry);
  try {
    await options.beforeActivate?.();
    await activate(targetInstallation);
    if (await health(validated.version)) {
      return { updated: true, version: validated.version, rolled_back: false };
    }
  } catch {}
  const rollbackInstallation = await install(rollbackSpec, validated.registry);
  await activate(rollbackInstallation);
  if (!(await health(options.currentVersion))) {
    throw new UpdateError(
      "rollback_health_failed",
      "Updated service and rollback both failed health checks",
    );
  }
  throw new UpdateError("update_health_failed", "Updated service failed health check and was rolled back");
}
