import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const BOOTSTRAP_URL = new URL("./harness-node-pty-bootstrap.mjs", import.meta.url);

function resolveNodePtyRoot(cordisConfig) {
  const require = createRequire(path.join(path.dirname(cordisConfig), "package.json"));
  return path.dirname(require.resolve("node-pty/package.json"));
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function replaceDirectory(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.cpSync(source, temporary, { recursive: true, force: true, preserveTimestamps: true });
  for (const arch of ["x64", "arm64"]) {
    const helper = path.join(temporary, "prebuilds", `darwin-${arch}`, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);
}

export function prepareHarnessNodePtyAdapter(options) {
  if (process.platform !== "darwin") return { ...(options.env || {}) };
  const sourceRoot = resolveNodePtyRoot(options.cordisConfig);
  const sourceHelper = path.join(
    sourceRoot,
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  if (!fs.existsSync(sourceHelper) || executable(sourceHelper)) {
    return { ...(options.env || {}) };
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
  );
  const destination = path.join(
    options.stateDir,
    "harness-adapters",
    `node-pty-${packageJson.version}-${process.arch}`,
  );
  replaceDirectory(sourceRoot, destination);

  const existingNodeOptions = options.env?.NODE_OPTIONS || "";
  const bootstrap = BOOTSTRAP_URL.href;
  return {
    ...(options.env || {}),
    NODE_OPTIONS: [existingNodeOptions, `--import=${bootstrap}`].filter(Boolean).join(" "),
    NINECODEX_NODE_PTY_ENTRY: path.join(destination, "lib", "index.js"),
    NINECODEX_PARENT_NODE_OPTIONS: existingNodeOptions,
  };
}
