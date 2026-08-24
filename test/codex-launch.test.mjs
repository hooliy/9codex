import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_AUTH_ENV,
  buildWindowsInteractiveLaunch,
  buildCodexLaunch,
  launchCodexDesktop,
  resolveCodexCommand,
  terminateWindowsCodex,
} from "../lib/codex-launch.mjs";

const input = {
  workspace: "/work/project",
  model: "cx/gpt-5.6-sol",
  modelCatalogJson: "/state/models.json",
  baseUrl: "http://127.0.0.1:10101/v1",
  home: "/home/test",
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
    "-c", 'mcp_servers.9codex.env={"NINECODEX_HOME"="/home/test"}',
    "-c", "mcp_servers.9codex.enabled=true",
    "-c", "mcp_servers.9codex.required=true",
    "-c", 'mcp_servers.9codex.enabled_tools=["image_gen"]',
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
    home: "/home/test",
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
  assert.ok(calls[0].args.includes(
    'mcp_servers.9codex.env={"NINECODEX_HOME"="/home/test"}',
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

test("copies the Microsoft Store Codex CLI outside WindowsApps before launching it", () => {
  const copied = [];
  const directories = [];
  const source = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__test\\app\\resources\\codex.exe";
  const destination = "C:\\Users\\m\\.9codex\\codex-app-cli\\OpenAI.Codex_1.2.3.0_x64__test\\codex.exe";
  assert.equal(resolveCodexCommand({
    platform: "win32",
    home: "C:\\Users\\m",
    appxInstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__test",
    exists: (file) => file === source,
    mkdir: (...args) => directories.push(args),
    copyFile: (...args) => copied.push(args),
  }), destination);
  assert.deepEqual(copied, [[source, destination]]);
  assert.deepEqual(directories, [[
    "C:\\Users\\m\\.9codex\\codex-app-cli\\OpenAI.Codex_1.2.3.0_x64__test",
    { recursive: true },
  ]]);
});

test("finds the Codex CLI bundled by the Windows desktop runtime", () => {
  assert.equal(resolveCodexCommand({
    platform: "win32",
    localAppData: "C:\\Users\\m\\AppData\\Local",
    readdirSync: () => ["old", "new"],
    exists: (file) => file === "C:\\Users\\m\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe",
  }), "C:\\Users\\m\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe");
});

test("bridges Windows desktop launch into the interactive user session", () => {
  const launch = buildWindowsInteractiveLaunch({
    platform: "win32",
    workspace: "C:\\work\\project",
    model: "cx/gpt-5.6-sol",
    modelCatalogJson: "C:\\Users\\m\\.9codex\\catalog.json",
    baseUrl: "http://127.0.0.1:10101/v1",
    home: "C:\\Users\\m",
    token: "secret-token",
    command: "C:\\Users\\m\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\m\\AppData\\Roaming\\npm\\node_modules\\@hooliy\\9codex\\bin\\9codex.mjs",
    restart: true,
  });

  assert.equal(launch.command, "powershell.exe");
  assert.match(launch.args.at(-1), /Register-ScheduledTask/);
  assert.match(launch.args.at(-1), /-LogonType Interactive/);
  assert.match(launch.args.at(-1), /Start-ScheduledTask/);
  assert.match(launch.args.at(-1), /Unregister-ScheduledTask/);
  assert.match(launch.args.at(-1), /codex-launch-worker/);
  assert.match(launch.args.at(-1), /--restart/);
  assert.doesNotMatch(launch.args.join(" "), /secret-token/);
});

test("Windows Codex shutdown is scoped to the installed Codex package", () => {
  const calls = [];
  terminateWindowsCodex({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {};
    },
  });

  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].args.at(-1), /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(calls[0].args.at(-1), /StartsWith\(\$root/);
  assert.match(calls[0].args.at(-1), /ChatGPT\.exe/);
  assert.match(calls[0].args.at(-1), /codex\.exe/);
});
