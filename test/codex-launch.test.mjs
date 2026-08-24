import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_AUTH_ENV,
  buildCodexLaunch,
  launchCodexDesktop,
  resolveCodexCommand,
} from "../lib/codex-launch.mjs";

const input = {
  workspace: "/work/project",
  model: "cx/gpt-5.6-sol",
  modelCatalogJson: "/state/models.json",
  baseUrl: "http://127.0.0.1:10101/v1",
  token: "secret-token",
  command: "/opt/bin/codex",
  nodePath: "/opt/bin/node",
  cliPath: "/opt/lib/9codex/bin/9codex.mjs",
  env: { PATH: "/opt/bin" },
};

test("builds non-persistent Codex Desktop overrides with fast mode and MCP", () => {
  const launch = buildCodexLaunch(input);

  assert.equal(launch.command, "/opt/bin/codex");
  assert.deepEqual(launch.args, [
    "app",
    "-c", 'model="cx/gpt-5.6-sol"',
    "-c", 'model_provider="9codex"',
    "-c", 'model_catalog_json="/state/models.json"',
    "-c", 'model_providers.9codex.name="9codex"',
    "-c", 'model_providers.9codex.base_url="http://127.0.0.1:10101/v1"',
    "-c", 'model_providers.9codex.wire_api="responses"',
    "-c", "model_providers.9codex.supports_websockets=false",
    "-c", `model_providers.9codex.env_key="${CODEX_AUTH_ENV}"`,
    "-c", 'service_tier="priority"',
    "-c", "features.multi_agent=true",
    "-c", 'multi_agent_mode="proactive"',
    "-c", 'mcp_servers.9codex.command="/opt/bin/node"',
    "-c", 'mcp_servers.9codex.args=["/opt/lib/9codex/bin/9codex.mjs","mcp"]',
    "-c", 'mcp_servers.9codex.default_tools_approval_mode="approve"',
    "/work/project",
  ]);
  assert.equal(launch.options.env[CODEX_AUTH_ENV], "secret-token");
  assert.equal(launch.options.env.PATH, "/opt/bin");
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.stdio, "inherit");

  const argv = launch.args.join(" ");
  assert.doesNotMatch(argv, /secret-token/);
  assert.doesNotMatch(
    argv,
    /model_reasoning_effort|model_verbosity|model_reasoning_summary/,
  );
});

test("launches through injected spawn and derives daemon values from config", () => {
  const calls = [];
  const child = {};
  const result = launchCodexDesktop({
    workspace: "/work/project",
    paths: { catalog: "/state/models.json" },
    config: {
      local: {
        host: "127.0.0.1",
        port: 10101,
        token: "local-secret",
      },
      upstream: { default_model: "yuanpi-auto" },
    },
    command: "custom-codex",
    nodePath: "custom-node",
    cliPath: "/app/bin/9codex.mjs",
    env: { HOME: "/home/test" },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "custom-codex");
  assert.equal(calls[0].args[0], "app");
  assert.equal(calls[0].args.at(-1), "/work/project");
  assert.ok(calls[0].args.includes('model="yuanpi-auto"'));
  assert.ok(calls[0].args.includes('model_catalog_json="/state/models.json"'));
  assert.ok(calls[0].args.includes(
    'model_providers.9codex.base_url="http://127.0.0.1:10101/v1"',
  ));
  assert.ok(calls[0].args.includes('mcp_servers.9codex.command="custom-node"'));
  assert.ok(calls[0].args.includes(
    'mcp_servers.9codex.args=["/app/bin/9codex.mjs","mcp"]',
  ));
  assert.equal(calls[0].options.env.HOME, "/home/test");
  assert.equal(calls[0].options.env[CODEX_AUTH_ENV], "local-secret");
  assert.doesNotMatch(calls[0].args.join(" "), /local-secret/);
});

test("requires authentication without persisting or exposing it", () => {
  assert.throws(
    () => buildCodexLaunch({ ...input, token: "", env: {} }),
    new RegExp(`env\\.${CODEX_AUTH_ENV} must be a non-empty string`),
  );
});

test("prefers the packaged Codex executable without changing user config", () => {
  assert.equal(resolveCodexCommand({
    platform: "darwin",
    exists: (file) => file === "/Applications/ChatGPT.app/Contents/Resources/codex",
  }), "/Applications/ChatGPT.app/Contents/Resources/codex");
});
