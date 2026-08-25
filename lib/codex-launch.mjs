import { execFileSync, spawn as spawnProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (/[\r\n]/.test(value)) throw new TypeError(`${name} must not contain newlines`);
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

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function windowsArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function appxInstallLocation(options = {}) {
  if (options.appxInstallLocation) return options.appxInstallLocation;
  try {
    return String((options.execFileSync || execFileSync)(
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
    return "";
  }
}

function prepareWindowsStoreCodex(options = {}) {
  const installLocation = appxInstallLocation(options);
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

export function buildCodexAppServerArguments(options = {}) {
  const config = options.config;
  const paths = options.paths;
  const model = options.model || config?.upstream?.default_model;
  const modelCatalogJson = options.modelCatalogJson || options.catalogPath || paths?.catalog;
  const home = options.home
    || paths?.home
    || options.env?.NINECODEX_HOME
    || process.env.NINECODEX_HOME
    || os.homedir();
  const baseUrl = options.baseUrl
    || (config?.local && `http://${config.local.host}:${config.local.port}/v1`);
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || process.argv[1];
  const serviceTier = options.serviceTier || "priority";

  [
    [model, "model"],
    [modelCatalogJson, "modelCatalogJson"],
    [home, "home"],
    [baseUrl, "baseUrl"],
    [nodePath, "nodePath"],
    [cliPath, "cliPath"],
    [serviceTier, "serviceTier"],
  ].forEach(([value, name]) => requireString(value, name));

  return [
    ...override("model", model),
    ...override("model_provider", "9codex"),
    ...override("model_catalog_json", modelCatalogJson),
    ...override("model_providers.9codex.name", "9codex"),
    ...override("model_providers.9codex.base_url", baseUrl),
    ...override("model_providers.9codex.wire_api", "responses"),
    ...override("model_providers.9codex.supports_websockets", false),
    ...override("model_providers.9codex.requires_openai_auth", false),
    ...override("model_providers.9codex.auth.command", nodePath),
    ...override("model_providers.9codex.auth.args", [cliPath, "auth-token"]),
    ...override("forced_login_method", "api"),
    ...override("service_tier", serviceTier),
    ...override("model_reasoning_effort", "high"),
    ...override("model_verbosity", "high"),
    ...override("model_reasoning_summary", "detailed"),
    ...override("features.fast_mode", true),
    ...override("features.multi_agent", true),
    ...override("multi_agent_mode", "proactive"),
    ...override("mcp_servers.9codex.command", nodePath),
    ...override("mcp_servers.9codex.args", [cliPath, "mcp"]),
    ...override("mcp_servers.9codex.env", { NINECODEX_HOME: home }),
    ...override("mcp_servers.9codex.enabled", true),
    ...override("mcp_servers.9codex.required", true),
    ...override("mcp_servers.9codex.enabled_tools", ["image_gen"]),
    ...override("mcp_servers.9codex.default_tools_approval_mode", "approve"),
  ];
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function wrapperSource(argumentsFile) {
  const escapedArgumentsFile = String(argumentsFile).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class NineCodexCodexWrapper {
  private const string ArgumentsFile = "${escapedArgumentsFile}";

  private static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return value;
    var result = new StringBuilder("\\\"");
    var slashes = 0;
    foreach (var character in value) {
      if (character == '\\\\') {
        slashes++;
      } else if (character == '"') {
        result.Append('\\\\', slashes * 2 + 1);
        result.Append('"');
        slashes = 0;
      } else {
        result.Append('\\\\', slashes);
        result.Append(character);
        slashes = 0;
      }
    }
    result.Append('\\\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }

  public static int Main(string[] args) {
    try {
      var configured = File.ReadAllLines(ArgumentsFile, Encoding.UTF8);
      if (configured.Length < 1 || configured[0].Length == 0) return 78;
      var forwarded = new List<string>();
      if (Array.IndexOf(args, "app-server") >= 0) {
        for (var index = 1; index < configured.Length; index++) {
          if (configured[index].Length > 0) forwarded.Add(configured[index]);
        }
      }
      forwarded.AddRange(args);
      var arguments = new StringBuilder();
      for (var index = 0; index < forwarded.Count; index++) {
        if (index > 0) arguments.Append(' ');
        arguments.Append(Quote(forwarded[index]));
      }
      var child = Process.Start(new ProcessStartInfo {
        FileName = configured[0],
        Arguments = arguments.ToString(),
        UseShellExecute = false,
        CreateNoWindow = false
      });
      if (child == null) return 1;
      child.WaitForExit();
      return child.ExitCode;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }
}`;
}

function compileWindowsWrapper(paths, options = {}) {
  const source = wrapperSource(paths.codexWrapperArgs);
  const hash = crypto.createHash("sha256")
    .update(source)
    .update("\0")
    .update(fs.readFileSync(paths.codexWrapperArgs))
    .digest("hex");
  const exists = options.exists || fs.existsSync;
  const destination = path.join(
    paths.stateDir,
    `codex-wrapper-${hash.slice(0, 16)}.exe`,
  );
  if (exists(destination)) return destination;
  const temporary = `${destination}.${process.pid}.tmp.exe`;
  const script = [
    `$source = ${powershellLiteral(source)}`,
    `Remove-Item -LiteralPath ${powershellLiteral(temporary)} -Force -ErrorAction SilentlyContinue`,
    `Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly ${powershellLiteral(temporary)} -OutputType ConsoleApplication`,
    `Move-Item -LiteralPath ${powershellLiteral(temporary)} -Destination ${powershellLiteral(destination)} -Force`,
  ].join("; ");
  (options.execFileSync || execFileSync)(
    options.powerShellCommand || "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  writeAtomic(paths.codexWrapperCurrent, `${destination}\n`);
  return destination;
}

function compilePosixWrapper(paths) {
  const configured = fs.readFileSync(paths.codexWrapperArgs, "utf8")
    .split(/\r?\n/)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
  const actualCodex = requireString(configured.shift(), "actualCodex");
  const injected = configured.map(shellLiteral).join(" ");
  const source = `#!/bin/sh
for argument do
  if [ "$argument" = "app-server" ]; then
    set -- ${injected} "$@"
    break
  fi
done
exec ${shellLiteral(actualCodex)} "$@"
`;
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const destination = path.join(paths.stateDir, `codex-wrapper-${hash.slice(0, 16)}`);
  if (!fs.existsSync(destination)) {
    writeAtomic(destination, source);
  }
  fs.chmodSync(destination, 0o700);
  writeAtomic(paths.codexWrapperCurrent, `${destination}\n`);
  return destination;
}

export function prepareCodexDesktopIntegration(options = {}) {
  const paths = options.paths;
  if (
    !paths?.stateDir
    || !paths?.codexWrapperArgs
    || !paths?.codexWrapperCurrent
    || !paths?.catalog
  ) {
    throw new Error("9codex integration paths are unavailable");
  }
  const actualCodex = resolveCodexCommand({
    ...options,
    codexCliPath: undefined,
    command: options.command,
  });
  requireString(actualCodex, "actualCodex");
  const args = buildCodexAppServerArguments(options);
  writeAtomic(paths.codexWrapperArgs, `${[actualCodex, ...args].join("\n")}\n`);
  const platform = options.platform || process.platform;
  const compileWrapper = options.compileWrapper
    || (platform === "win32" ? compileWindowsWrapper : compilePosixWrapper);
  const wrapperPath = compileWrapper(paths, options);
  return {
    wrapperPath: requireString(wrapperPath, "wrapperPath"),
  };
}

function desktopUri(workspace) {
  return `codex://threads/new?path=${encodeURIComponent(workspace)}`;
}

function windowsDesktopLaunchScript({ wrapperPath, catalogPath, workspace }) {
  const uri = desktopUri(workspace);
  return [
    `$wrapper = ${powershellLiteral(wrapperPath)}`,
    `$catalog = ${powershellLiteral(catalogPath)}`,
    `$uri = ${powershellLiteral(uri)}`,
    "if ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User') -ne $wrapper) { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $wrapper, 'User') }",
    "$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "$wrapperProcessIds = @($processes | Where-Object { $_.ExecutablePath -eq $wrapper } | ForEach-Object { $_.ProcessId })",
    "$appServer = $processes | Where-Object { $_.Name -eq 'codex.exe' -and $wrapperProcessIds -contains $_.ParentProcessId -and $_.CommandLine -and $_.CommandLine.Contains($catalog) -and $_.CommandLine.Contains('model_provider') -and $_.CommandLine.Contains('9codex') } | Select-Object -First 1",
    "if (-not $appServer) {",
    "  Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force",
    "  $deadline = (Get-Date).AddSeconds(5)",
    "  while ((Get-Process ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }",
    "  if (Get-Process ChatGPT -ErrorAction SilentlyContinue) { throw 'Codex Desktop did not stop within 5 seconds' }",
    "}",
    "$env:CODEX_CLI_PATH = $wrapper",
    "Start-Process $uri",
  ].join("; ");
}

export function buildWindowsInteractiveLaunch(options = {}) {
  const workspace = requireString(options.workspace || process.cwd(), "workspace");
  const home = requireString(
    options.home || process.env.USERPROFILE || os.homedir(),
    "home",
  );
  const wrapperPath = requireString(options.wrapperPath, "wrapperPath");
  const catalogPath = requireString(options.catalogPath, "catalogPath");
  const taskName = `9codex-codex-launch-${process.pid}-${Date.now()}`;
  const launchScript = windowsDesktopLaunchScript({
    wrapperPath,
    catalogPath,
    workspace,
  });
  const taskArgument = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    launchScript,
  ].map(windowsArgument).join(" ");
  const script = [
    `$taskName = ${powershellLiteral(taskName)}`,
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${powershellLiteral(taskArgument)} -WorkingDirectory ${powershellLiteral(home)}`,
    "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
    "$before = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime",
    "Start-ScheduledTask -TaskName $taskName",
    "do {",
    "  Start-Sleep -Milliseconds 100",
    "  $task = Get-ScheduledTask -TaskName $taskName",
    "  $info = Get-ScheduledTaskInfo -TaskName $taskName",
    "} while ($info.LastRunTime -eq $before -or $task.State -eq 'Running')",
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

export function macDesktopUsesIntegration(options = {}) {
  const catalogPath = requireString(options.catalogPath, "catalogPath");
  let output;
  try {
    output = String((options.execFileSync || execFileSync)(
      "/bin/ps",
      ["-axo", "pid=,ppid=,command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ));
  } catch {
    return false;
  }
  const processes = output.split("\n").map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  }).filter(Boolean);
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return processes.some((process) => {
    const parent = byPid.get(process.ppid);
    return process.command.includes(" app-server")
      && process.command.includes(catalogPath)
      && process.command.includes("model_provider")
      && process.command.includes("9codex")
      && parent?.command.includes("/ChatGPT.app/Contents/MacOS/ChatGPT");
  });
}

export function buildMacDesktopLaunch(options = {}) {
  const workspace = requireString(options.workspace || process.cwd(), "workspace");
  const wrapperPath = requireString(options.wrapperPath, "wrapperPath");
  const uri = desktopUri(workspace);
  const script = [
    `wrapper=${shellLiteral(wrapperPath)}`,
    `uri=${shellLiteral(uri)}`,
    '/bin/launchctl setenv CODEX_CLI_PATH "$wrapper"',
    ...(options.restartDesktop ? [
    `desktop_pid=$(/bin/ps -axo pid=,command= | /usr/bin/awk '$2 == "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" { print $1; exit }')`,
    `  if [ -n "$desktop_pid" ]; then`,
    `    /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'`,
    "    /bin/sleep 1",
    '    if /bin/kill -0 "$desktop_pid" 2>/dev/null; then /bin/kill -TERM "$desktop_pid"; fi',
    "    /bin/sleep 1",
    '    if /bin/kill -0 "$desktop_pid" 2>/dev/null; then /bin/kill -KILL "$desktop_pid"; fi',
    "    deadline=$(( $(/bin/date +%s) + 2 ))",
    '    while /bin/kill -0 "$desktop_pid" 2>/dev/null; do',
    '      [ "$(/bin/date +%s)" -lt "$deadline" ] || { echo "Codex Desktop did not stop within 4 seconds" >&2; exit 1; }',
    "      /bin/sleep 0.1",
    "    done",
    "  fi",
    ] : []),
    '/usr/bin/open "$uri"',
  ].join("\n");
  return {
    command: "/bin/sh",
    args: ["-c", script],
    options: {
      env: { ...(options.env || process.env), CODEX_CLI_PATH: wrapperPath },
      shell: false,
      stdio: "inherit",
    },
  };
}

export function launchCodexDesktop(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(`9codex Desktop integration does not support ${platform}`);
  }
  const integration = (options.prepareIntegration || prepareCodexDesktopIntegration)(options);
  if (platform === "darwin") {
    const catalogPath = options.modelCatalogJson || options.paths?.catalog;
    const launch = buildMacDesktopLaunch({
      ...options,
      ...integration,
      restartDesktop: !(options.desktopUsesIntegration || macDesktopUsesIntegration)({
        ...options,
        catalogPath,
      }),
    });
    return (options.spawn || spawnProcess)(launch.command, launch.args, launch.options);
  }
  if (options.interactiveSessionBridge !== false) {
    const launch = buildWindowsInteractiveLaunch({
      ...options,
      ...integration,
      catalogPath: options.modelCatalogJson || options.paths?.catalog,
    });
    return (options.spawn || spawnProcess)(launch.command, launch.args, launch.options);
  }
  const workspace = requireString(options.workspace || process.cwd(), "workspace");
  const script = windowsDesktopLaunchScript({
    wrapperPath: integration.wrapperPath,
    catalogPath: options.modelCatalogJson || options.paths?.catalog,
    workspace,
  });
  return (options.spawn || spawnProcess)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...(options.env || process.env) },
      shell: false,
      stdio: "inherit",
    },
  );
}
