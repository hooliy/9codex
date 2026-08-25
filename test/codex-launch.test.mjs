import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMacDesktopLaunch,
  buildWindowsInteractiveLaunch,
  buildCodexAppServerArguments,
  launchCodexDesktop,
  macDesktopUsesIntegration,
  prepareCodexDesktopIntegration,
  resolveCodexCommand,
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

test("builds app-server overrides from the 9codex gateway catalog", () => {
  assert.deepEqual(buildCodexAppServerArguments(input), [
    "-c", 'model="cx/gpt-5.6-sol"',
    "-c", 'model_provider="9codex"',
    "-c", 'model_catalog_json="/state/models.json"',
    "-c", 'model_providers.9codex.name="9codex"',
    "-c", 'model_providers.9codex.base_url="http://127.0.0.1:10101/v1"',
    "-c", 'model_providers.9codex.wire_api="responses"',
    "-c", "model_providers.9codex.supports_websockets=false",
    "-c", "model_providers.9codex.requires_openai_auth=false",
    "-c", 'model_providers.9codex.auth.command="/opt/bin/node"',
    "-c", 'model_providers.9codex.auth.args=["/opt/lib/9codex/bin/9codex.mjs","auth-token"]',
    "-c", 'forced_login_method="api"',
    "-c", 'service_tier="priority"',
    "-c", 'model_reasoning_effort="high"',
    "-c", 'model_verbosity="high"',
    "-c", 'model_reasoning_summary="detailed"',
    "-c", "features.fast_mode=true",
    "-c", "features.multi_agent=true",
    "-c", 'multi_agent_mode="proactive"',
    "-c", 'mcp_servers.9codex.command="/opt/bin/node"',
    "-c", 'mcp_servers.9codex.args=["/opt/lib/9codex/bin/9codex.mjs","mcp"]',
    "-c", 'mcp_servers.9codex.env={"NINECODEX_HOME"="/home/test"}',
    "-c", "mcp_servers.9codex.enabled=true",
    "-c", "mcp_servers.9codex.required=true",
    "-c", 'mcp_servers.9codex.enabled_tools=["image_gen"]',
    "-c", 'mcp_servers.9codex.default_tools_approval_mode="approve"',
  ]);

  const argv = buildCodexAppServerArguments(input).join(" ");
  assert.doesNotMatch(argv, /secret-token/);
  assert.doesNotMatch(argv, /env_key/);
});

test("launches Desktop directly with the generated wrapper instead of codex app", () => {
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
    platform: "win32",
    interactiveSessionBridge: false,
    prepareIntegration: () => ({
      wrapperPath: "C:\\Users\\m\\.9codex\\codex-wrapper.exe",
    }),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].args.at(-1), /codex:\/\/threads\/new\?path=/);
  assert.match(calls[0].args.at(-1), /CODEX_CLI_PATH/);
  assert.match(calls[0].args.at(-1), /codex-wrapper\.exe/);
  assert.doesNotMatch(calls[0].args.join(" "), /local-secret|codex app/);
});

test("launches macOS Desktop through the 9codex wrapper", () => {
  const calls = [];
  const child = {};
  const result = launchCodexDesktop({
    ...input,
    paths: { catalog: "/state/models.json" },
    platform: "darwin",
    desktopUsesIntegration: () => false,
    prepareIntegration: () => ({
      wrapperPath: "/home/test/.9codex/codex-wrapper-test",
    }),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.match(calls[0].args.at(-1), /launchctl setenv CODEX_CLI_PATH/);
  assert.match(calls[0].args.at(-1), /codex:\/\/threads\/new\?path=/);
  assert.doesNotMatch(calls[0].args.join(" "), /secret-token|config\.toml/);
});

test("builds an executable macOS wrapper without modifying Codex files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-mac-wrapper-test-"));
  const paths = {
    home: root,
    stateDir: path.join(root, ".9codex"),
    catalog: path.join(root, ".9codex", "catalog.json"),
    codexWrapperArgs: path.join(root, ".9codex", "codex-wrapper.args"),
    codexWrapperCurrent: path.join(root, ".9codex", "codex-wrapper.current"),
  };

  const integration = prepareCodexDesktopIntegration({
    ...input,
    platform: "darwin",
    paths,
  });

  const source = fs.readFileSync(integration.wrapperPath, "utf8");
  assert.match(source, /^#!\/bin\/sh/);
  assert.match(source, /app-server/);
  assert.match(source, /exec '\/opt\/bin\/codex'/);
  assert.match(source, /model_provider="9codex"/);
  assert.equal(fs.statSync(integration.wrapperPath).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(root, ".codex", "config.toml")), false);
  assert.doesNotMatch(source, /secret-token/);
});

test("macOS launch restarts Desktop only when its app-server lacks the gateway catalog", () => {
  const launch = buildMacDesktopLaunch({
    workspace: "/work/project",
    wrapperPath: "/home/test/.9codex/codex-wrapper-test",
    restartDesktop: true,
    openWorkspace: false,
  });

  assert.equal(launch.command, "/bin/sh");
  assert.match(launch.args.at(-1), /osascript/);
  assert.match(launch.args.at(-1), /tell application id "com\.openai\.codex" to quit/);
  assert.match(launch.args.at(-1), /desktop_pid=/);
  assert.match(launch.args.at(-1), /kill -TERM "\$desktop_pid"/);
  assert.match(launch.args.at(-1), /kill -KILL "\$desktop_pid"/);
  assert.match(launch.args.at(-1), /\/usr\/bin\/open -b com\.openai\.codex/);
  assert.doesNotMatch(launch.args.at(-1), /codex:\/\/|threads\/new/);
});

test("detects only a gateway-backed macOS Desktop app-server", () => {
  const catalog = "/home/test/.9codex/catalog.json";
  const processList = [
    " 100 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    ` 101 100 /Applications/ChatGPT.app/Contents/Resources/codex -c model_provider="9codex" -c model_catalog_json="${catalog}" app-server`,
    ` 102 1 /opt/bin/codex -c model_provider="9codex" -c model_catalog_json="${catalog}" app-server`,
  ].join("\n");
  assert.equal(macDesktopUsesIntegration({
    catalogPath: catalog,
    execFileSync: () => processList,
  }), true);
  assert.equal(macDesktopUsesIntegration({
    catalogPath: "/another/catalog.json",
    execFileSync: () => processList,
  }), false);
});

test("does not restart an already integrated macOS Desktop", () => {
  const launch = buildMacDesktopLaunch({
    workspace: "/work/project",
    wrapperPath: "/home/test/.9codex/codex-wrapper-test",
    restartDesktop: false,
    openWorkspace: false,
  });
  assert.doesNotMatch(launch.args.at(-1), /osascript|quit/);
  assert.match(launch.args.at(-1), /\/usr\/bin\/open -b com\.openai\.codex/);
  assert.doesNotMatch(launch.args.at(-1), /codex:\/\/|threads\/new/);
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

test("never resolves the 9codex wrapper as the underlying Codex CLI", () => {
  const previous = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "C:\\Users\\m\\.9codex\\codex-wrapper.exe";
  try {
    assert.equal(resolveCodexCommand({
      platform: "win32",
      localAppData: "C:\\Users\\m\\AppData\\Local",
      readdirSync: () => ["runtime"],
      exists: (file) => file.endsWith("\\runtime\\codex.exe"),
    }), "C:\\Users\\m\\AppData\\Local\\OpenAI\\Codex\\bin\\runtime\\codex.exe");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previous;
  }
});

test("prepare integration ignores CODEX_CLI_PATH and records the real Codex binary", async () => {
  const { prepareCodexDesktopIntegration } = await import("../lib/codex-launch.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-wrapper-test-"));
  const paths = {
    home: root,
    stateDir: root,
    catalog: path.join(root, "catalog.json"),
    codexWrapperArgs: path.join(root, "codex-wrapper.args"),
    codexWrapperCurrent: path.join(root, "codex-wrapper.current"),
  };
  const previous = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = path.join(root, "codex-wrapper-old.exe");
  try {
    prepareCodexDesktopIntegration({
      ...input,
      command: undefined,
      platform: "win32",
      paths,
      localAppData: "C:\\Users\\m\\AppData\\Local",
      readdirSync: () => ["runtime"],
      exists: (file) => file.endsWith("\\runtime\\codex.exe"),
      compileWrapper: () => path.join(root, "codex-wrapper-new.exe"),
    });
    assert.equal(
      fs.readFileSync(paths.codexWrapperArgs, "utf8").split(/\r?\n/, 1)[0],
      "C:\\Users\\m\\AppData\\Local\\OpenAI\\Codex\\bin\\runtime\\codex.exe",
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previous;
  }
});

test("compiled wrapper inherits app-server stdio without an async proxy", async () => {
  const source = fs.readFileSync(
    new URL("../lib/codex-launch.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /CreateNoWindow = false/);
  assert.doesNotMatch(source, /RedirectStandard(?:Input|Output|Error) = true/);
  assert.doesNotMatch(source, /CopyToAsync/);
});

test("integration wrapper identity changes when gateway launch arguments change", async () => {
  const { prepareCodexDesktopIntegration } = await import("../lib/codex-launch.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9codex-wrapper-identity-test-"));
  const paths = {
    home: root,
    stateDir: root,
    catalog: path.join(root, "catalog.json"),
    codexWrapperArgs: path.join(root, "codex-wrapper.args"),
    codexWrapperCurrent: path.join(root, "codex-wrapper.current"),
  };
  const common = {
    ...input,
    command: "C:\\Codex\\codex.exe",
    platform: "win32",
    paths,
    exists: () => false,
    execFileSync: () => "",
  };
  const first = prepareCodexDesktopIntegration({ ...common, model: "model-a" });
  const second = prepareCodexDesktopIntegration({ ...common, model: "model-b" });
  assert.notEqual(first.wrapperPath, second.wrapperPath);
});

test("bridges Windows desktop launch into the interactive user session", () => {
  const launch = buildWindowsInteractiveLaunch({
    platform: "win32",
    workspace: "C:\\work\\project",
    home: "C:\\Users\\m",
    wrapperPath: "C:\\Users\\m\\.9codex\\codex-wrapper.exe",
    catalogPath: "C:\\Users\\m\\.9codex\\9codex-model-catalog.json",
  });

  assert.equal(launch.command, "powershell.exe");
  assert.match(launch.args.at(-1), /Register-ScheduledTask/);
  assert.match(launch.args.at(-1), /-LogonType Interactive/);
  assert.match(launch.args.at(-1), /Start-ScheduledTask/);
  assert.match(launch.args.at(-1), /Unregister-ScheduledTask/);
  assert.match(launch.args.at(-1), /CODEX_CLI_PATH/);
  assert.match(launch.args.at(-1), /SetEnvironmentVariable/);
  assert.match(launch.args.at(-1), /ExecutablePath -eq \$wrapper/);
  assert.match(launch.args.at(-1), /9codex-model-catalog\.json/);
  assert.match(launch.args.at(-1), /Stop-Process -Force/);
  assert.match(launch.args.at(-1), /codex:\/\/threads\/new\?path=/);
  assert.doesNotMatch(launch.args.at(-1), /codex-launch-worker|codex\.exe app/);
  assert.doesNotMatch(launch.args.at(-1), /taskkill|\/F/);
  assert.match(launch.args.at(-1), /LastRunTime -eq \$before/);
  assert.doesNotMatch(launch.args.at(-1), /LastRunTime -lt \$started/);
});
