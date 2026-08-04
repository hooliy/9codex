import net from "node:net";

const MODEL_CONFIG_ID = "107580212";

export function buildModelPickerOverrideScript() {
  return `(() => {
    const root = window.__STATSIG__;
    const client = root?.firstInstance;
    if (!client || typeof client.getDynamicConfig !== "function") {
      return { applied: false, reason: "statsig-unavailable" };
    }
    let changed = false;
    if (!client.__ninecodexModelPickerOverride) {
      const previousAdapter = client.overrideAdapter;
      const adapter = Object.create(previousAdapter || null);
      adapter.getDynamicConfigOverride = function(config, user, options) {
        const resolved = previousAdapter?.getDynamicConfigOverride?.call(
          previousAdapter,
          config,
          user,
          options,
        ) || config;
        if (resolved?.name === "${MODEL_CONFIG_ID}") {
          resolved.value = { ...resolved.value, use_hidden_models: false };
        }
        return resolved;
      };
      client.overrideAdapter = adapter;
      client.__ninecodexModelPickerOverride = true;
      changed = true;
    }
    client._memoCache = {};
    if (changed) client.$emt?.({ name: "values_updated", status: "Ready", values: null });
    const value = client.getDynamicConfig("${MODEL_CONFIG_ID}").value;
    return {
      applied: client.__ninecodexModelPickerOverride === true,
      useHiddenModels: value?.use_hidden_models,
    };
  })()`;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function evaluateTargetDefault(target, source) {
  const socket = await connect(target.webSocketDebuggerUrl);
  try {
    const id = 1;
    const response = new Promise((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
    });
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: source,
        returnByValue: true,
        awaitPromise: true,
      },
    }));
    const result = await response;
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
    return result.result?.value;
  } finally {
    socket.close();
  }
}

async function listTargetsDefault(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Codex debugging endpoint returned HTTP ${response.status}`);
  return response.json();
}

export async function enableModelPicker(options) {
  const listTargets = options.listTargets || (() => listTargetsDefault(options.port));
  const evaluateTarget = options.evaluateTarget || evaluateTargetDefault;
  const targets = await listTargets();
  const renderers = targets.filter((target) =>
    target.type === "page" &&
    !String(target.url || "").includes("avatar-overlay") &&
    target.webSocketDebuggerUrl !== "",
  );
  if (renderers.length === 0) throw new Error("Codex main renderer is not available");
  const source = buildModelPickerOverrideScript();
  const results = [];
  for (const target of renderers) results.push(await evaluateTarget(target, source));
  const verified = results.some((result) => result?.applied === true && result?.useHiddenModels === false);
  if (!verified) throw new Error("Codex model picker override was not applied");
  return { connected: true, patched: results.filter((result) => result?.applied).length, verified };
}

export async function waitForModelPicker(options) {
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts || 40;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await enableModelPicker(options);
    } catch (error) {
      lastError = error;
      await wait(500);
    }
  }
  throw lastError || new Error("Codex model picker integration timed out");
}

export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
