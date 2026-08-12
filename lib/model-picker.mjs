import net from "node:net";

const MODEL_POLICY_ID = "107580212";

export function buildModelPickerPolicyScript() {
  return `(() => {
    const root = window.__STATSIG__;
    const instances = [
      root?.firstInstance,
      ...(
        Array.isArray(root?.instances)
          ? root.instances
          : Object.values(root?.instances || {})
      ),
    ].filter((client, index, all) => client && all.indexOf(client) === index);
    let applied = 0;
    let useHiddenModels;
    for (const client of instances) {
      if (typeof client.getDynamicConfig !== "function") continue;
      if (!client.__ninecodexModelPickerPolicy) {
        const previousAdapter = client.overrideAdapter;
        const adapter = Object.create(previousAdapter || null);
        adapter.getDynamicConfigOverride = function(config, user, options) {
          const resolved = previousAdapter?.getDynamicConfigOverride?.call(
            previousAdapter,
            config,
            user,
            options,
          ) || config;
          if (resolved?.name !== "${MODEL_POLICY_ID}") return resolved;
          return {
            ...resolved,
            value: {
              ...(resolved.value || {}),
              use_hidden_models: false,
            },
          };
        };
        client.overrideAdapter = adapter;
        client.__ninecodexModelPickerPolicy = true;
      }
      client._memoCache = {};
      client.$emt?.({ name: "values_updated", status: "Ready", values: null });
      const value = client.getDynamicConfig("${MODEL_POLICY_ID}")?.value;
      useHiddenModels = value?.use_hidden_models;
      if (useHiddenModels === false) applied += 1;
    }
    return instances.length === 0
      ? { applied: false, reason: "statsig-unavailable" }
      : { applied: applied > 0, patched: applied, useHiddenModels };
  })()`;
}

function connect(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Codex renderer connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Codex renderer connection failed"));
    }, { once: true });
  });
}

export async function evaluateCodexRenderer(target, source) {
  const socket = await connect(target.webSocketDebuggerUrl);
  try {
    const id = 1;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex renderer evaluation timed out")), 1500);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Codex renderer evaluation failed");
    }
    return result.result?.value;
  } finally {
    socket.close();
  }
}

export async function listCodexRendererTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Codex debugging endpoint returned HTTP ${response.status}`);
  return response.json();
}

export async function applyModelPickerPolicy(options) {
  const targets = await (options.listTargets || (() => listCodexRendererTargets(options.port)))();
  const evaluateTarget = options.evaluateTarget || evaluateCodexRenderer;
  const renderers = targets.filter((target) =>
    target.type === "page"
    && !String(target.url || "").includes("avatar-overlay"),
  );
  if (renderers.length === 0) throw new Error("Codex main renderer is not available");

  const source = buildModelPickerPolicyScript();
  const results = [];
  for (const target of renderers) results.push(await evaluateTarget(target, source));
  const verified = results.some((result) =>
    result?.applied === true && result?.useHiddenModels === false,
  );
  if (!verified) throw new Error("Codex model picker policy was not applied");
  return {
    connected: true,
    patched: results.reduce(
      (count, result) => count + (Number(result?.patched) || (result?.applied ? 1 : 0)),
      0,
    ),
    verified: true,
  };
}

export async function waitForModelPickerPolicy(options) {
  const wait = options.wait || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts || 40;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await applyModelPickerPolicy(options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await wait(500);
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

// ponytail: Codex Desktop 暂无公开的自定义模型可见性配置；上游开放后删除此模块。
