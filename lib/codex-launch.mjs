import { execFileSync, spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_AUTH_ENV = "NINECODEX_CODEX_API_KEY";

function prepareWindowsStoreCodex(options = {}) {
  let installLocation = options.appxInstallLocation;
  if (!installLocation) {
    try {
      installLocation = String((options.execFileSync || execFileSync)(
        options.powerShellCommand || "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )).trim();
    } catch {
      return null;
    }
  }
  if (!installLocation) return null;
  const exists = options.exists || fs.existsSync;
  const source = path.win32.join(installLocation, "app", "resources", "codex.exe");
  if (!exists(source)) return null;
  const home = options.home || process.env.USERPROFILE || os.homedir();
  const destination = path.win32.join(
    home,
    ".9codex",
    "codex-app-cli",
    path.win32.basename(installLocation),
    "codex.exe",
  );
  if (!exists(destination)) {
    (options.mkdir || fs.mkdirSync)(path.win32.dirname(destination), { recursive: true });
    (options.copyFile || fs.copyFileSync)(source, destination);
  }
  return destination;
}

function resolveWindowsCodexCli(options = {}) {
  const exists = options.exists || fs.existsSync;
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || "";
  const candidates = [
    options.codexCliPath,
    process.env.CODEX_CLI_PATH,
    `${localAppData}\\Programs\\ChatGPT\\resources\\codex.exe`,
  ];
  const runtimeRoot = path.win32.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    candidates.push(...(options.readdirSync || fs.readdirSync)(runtimeRoot)
      .sort()
      .reverse()
      .map((version) => path.win32.join(runtimeRoot, version, "codex.exe")));
  } catch {}
  return candidates.find((candidate) => candidate && exists(candidate))
    || prepareWindowsStoreCodex(options)
    || "codex.exe";
}

export function resolveCodexCommand(options = {}) {
  if (options.command) return options.command;
  const platform = options.platform || process.platform;
  if (platform === "win32") return resolveWindowsCodexCli(options);
  const exists = options.exists || fs.existsSync;
  const candidates = platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "codex",
      ]
    : ["/usr/local/bin/codex", "/usr/bin/codex", "codex"];
  return candidates.find((candidate) => (
    (candidate.includes("/") || candidate.includes("\\"))
    && exists(candidate)
  )) || candidates.at(-1);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function override(key, value) {
  return ["-c", `${key}=${toml(value)}`];
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildWindowsInteractiveLaunch(options = {}) {
  const cliPath = requireString(options.cliPath, "cliPath");
  const workspace = requireString(options.workspace || process.cwd(), "workspace");
  const home = requireString(
    options.home || process.env.USERPROFILE || os.homedir(),
    "home",
  );
  const taskName = `9codex-codex-launch-${process.pid}-${Date.now()}`;
  const workerArgs = [
    `"${cliPath.replaceAll('"', '\\"')}"`,
    "codex-launch-worker",
    ...(options.restart ? ["--restart"] : []),
    `"${workspace.replaceAll('"', '\\"')}"`,
  ].join(" ");
  const script = [
    `$taskName = ${powershellLiteral(taskName)}`,
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(options.nodePath || process.execPath)} -Argument ${powershellLiteral(workerArgs)} -WorkingDirectory ${powershellLiteral(home)}`,
    "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(1)",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
    "$started = Get-Date",
    "Start-ScheduledTask -TaskName $taskName",
    "do {",
    "  Start-Sleep -Milliseconds 250",
    "  $task = Get-ScheduledTask -TaskName $taskName",
    "  $info = Get-ScheduledTaskInfo -TaskName $taskName",
    "} while ($info.LastRunTime -lt $started -or $task.State -eq 'Running')",
    "$result = $info.LastTaskResult",
    "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue",
    "if ($result -ne 0) { exit $result }",
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    options: { windowsHide: true, stdio: "inherit" },
    taskName,
  };
}

export function terminateWindowsCodex(options = {}) {
  const spawn = options.spawn || spawnProcess;
  const script = [
    "$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $package) { exit 0 }",
    "$root = $package.InstallLocation",
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {",
    "  if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and ($_.Name -eq 'ChatGPT.exe' -or $_.Name -eq 'codex.exe')) {",
    "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
    "  }",
    "}",
  ].join("; ");
  return spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export function buildCodexLaunch(options = {}) {
  const config = options.config;
  const paths = options.paths;
  const workspace = options.workspace || process.cwd();
  const model = options.model || config?.upstream?.default_model;
  const modelCatalogJson = options.modelCatalogJson || options.catalogPath || paths?.catalog;
  const home = options.home
    || paths?.home
    || options.env?.NINECODEX_HOME
    || process.env.NINECODEX_HOME
    || os.homedir();
  const command = resolveCodexCommand({ ...options, home });
  const baseUrl = options.baseUrl
    || (config?.local && `http://${config.local.host}:${config.local.port}/v1`);
  const authEnvKey = options.authEnvKey || CODEX_AUTH_ENV;
  const token = options.token || config?.local?.token || options.env?.[authEnvKey];
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || process.argv[1];
  const serviceTier = options.serviceTier || "priority";

  [
    [command, "command"],
    [workspace, "workspace"],
    [model, "model"],
    [modelCatalogJson, "modelCatalogJson"],
    [home, "home"],
    [baseUrl, "baseUrl"],
    [authEnvKey, "authEnvKey"],
    [token, `env.${authEnvKey}`],
    [nodePath, "nodePath"],
    [cliPath, "cliPath"],
    [serviceTier, "serviceTier"],
  ].forEach(([value, name]) => requireString(value, name));

  const args = [
    "app",
    ...override("model", model),
    ...override("model_provider", "9codex"),
    ...override("model_catalog_json", modelCatalogJson),
    ...override("model_providers.9codex.name", "9codex"),
    ...override("model_providers.9codex.base_url", baseUrl),
    ...override("model_providers.9codex.wire_api", "responses"),
    ...override("model_providers.9codex.supports_websockets", false),
    ...override("model_providers.9codex.env_key", authEnvKey),
    ...override("service_tier", serviceTier),
    ...override("features.multi_agent", true),
    ...override("multi_agent_mode", "proactive"),
    ...override("mcp_servers.9codex.command", nodePath),
    ...override("mcp_servers.9codex.args", [cliPath, "mcp"]),
    ...override("mcp_servers.9codex.env", { NINECODEX_HOME: home }),
    ...override("mcp_servers.9codex.enabled", true),
    ...override("mcp_servers.9codex.required", true),
    ...override("mcp_servers.9codex.enabled_tools", ["image_gen"]),
    ...override("mcp_servers.9codex.default_tools_approval_mode", "approve"),
    workspace,
  ];

  return {
    command,
    args,
    options: {
      env: { ...(options.env || process.env), [authEnvKey]: token },
      shell: false,
      stdio: "inherit",
    },
  };
}

export function launchCodexDesktop(options = {}) {
  if ((options.platform || process.platform) === "win32" && options.interactiveSessionBridge !== false) {
    const launch = buildWindowsInteractiveLaunch(options);
    return (options.spawn || spawnProcess)(launch.command, launch.args, launch.options);
  }
  const launch = buildCodexLaunch(options);
  return (options.spawn || spawnProcess)(launch.command, launch.args, launch.options);
}
