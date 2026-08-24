import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function runDefault(file, args, options = {}) {
  return new Promise((resolve) => {
    const capture = options.capture === true;
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: options.inherit ? "inherit" : capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", (error) => resolve(capture
      ? { status: -1, stdout, stderr: error.message }
      : -1));
    child.on("close", (status) => resolve(capture
      ? { status: status ?? -1, stdout, stderr }
      : status));
  });
}

function waitDefault(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandStatus(result) {
  return typeof result === "number" ? result : result.status;
}

function commandFailure(command, result) {
  const detail = typeof result === "number"
    ? ""
    : (result.stderr || result.stdout || "").trim();
  return `${command} failed with status ${commandStatus(result)}${detail ? `: ${detail}` : ""}`;
}

function recordedPid(paths) {
  try {
    const text = fs.readFileSync(paths.daemonPid, "utf8").trim();
    if (!/^[1-9]\d*$/.test(text)) return 0;
    const pid = Number(text);
    return Number.isSafeInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function windowsLauncherCompilation(paths) {
  const source = `using System;
using System.Diagnostics;
using System.Text;

public static class NineCodexServiceLauncher {
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
    if (args.Length < 2) return 64;
    try {
      var arguments = new StringBuilder();
      for (var index = 1; index < args.Length; index++) {
        if (index > 1) arguments.Append(' ');
        arguments.Append(Quote(args[index]));
      }
      var child = Process.Start(new ProcessStartInfo {
        FileName = args[0],
        Arguments = arguments.ToString(),
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden
      });
      if (child == null) return 1;
      child.WaitForExit();
      return child.ExitCode;
    } catch {
      return 1;
    }
  }
}`;
  const temporary = `${paths.serviceLauncher}.new.exe`;
  return [
    `$source = ${powershellLiteral(source)}`,
    `Remove-Item -LiteralPath ${powershellLiteral(temporary)} -Force -ErrorAction SilentlyContinue`,
    `Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly ${powershellLiteral(temporary)} -OutputType WindowsApplication`,
    `Move-Item -LiteralPath ${powershellLiteral(temporary)} -Destination ${powershellLiteral(paths.serviceLauncher)} -Force`,
  ].join("; ");
}

function windowsTaskRegistration(paths, nodePath, cliPath) {
  const daemonArgs = [
    windowsArgument(nodePath),
    windowsArgument(cliPath),
    "daemon",
    "--redirect-logs",
  ].join(" ");
  return [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(paths.serviceLauncher)} -Argument ${powershellLiteral(daemonArgs)} -WorkingDirectory ${powershellLiteral(paths.home)}`,
    "$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName '9codex' -Action $action -Trigger $logonTrigger -Principal $principal -Settings $settings -Force | Out-Null",
  ].join("; ");
}

async function terminateWindowsDaemons(paths, run) {
  const pid = recordedPid(paths);
  const script = [
    `$recordedPid = ${pid}`,
    `$launcher = ${powershellLiteral(paths.serviceLauncher)}`,
    "$pattern = '(?i)(?:^|\\s)\"?[^\"\\r\\n]*[\\\\/]9codex\\.mjs\"?\\s+daemon(?:\\s|$)'",
    "$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "foreach ($process in $processes) {",
    "  $owned = $process.CommandLine -match $pattern -or $process.ExecutablePath -eq $launcher",
    "  if ($owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("; ");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (fs.existsSync(paths.daemonPid)) fs.unlinkSync(paths.daemonPid);
}

function rotateDaemonLog(paths) {
  try {
    if (fs.statSync(paths.daemonLog).size > 256 * 1024) {
      fs.renameSync(paths.daemonLog, `${paths.daemonLog}.${Date.now()}.bak`);
    } else {
      fs.writeFileSync(paths.daemonLog, "");
    }
  } catch {}
}

async function killStaleDaemonLoops(run) {
  const script = [
    "$pattern = '(?i)9codex\\.mjs.+daemon'",
    "$loopPattern = '(?i)while\\s*\\(\\$true\\).+9codex\\.mjs.+daemon'",
    "$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "foreach ($process in $processes) {",
    "  if ($process.CommandLine -match $loopPattern) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
    "  elseif ($process.CommandLine -match $pattern -and $process.CommandLine -notmatch $loopPattern) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("; ");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

export async function installService(paths, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || runDefault;
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath;
  if (!cliPath) throw new Error("cliPath is required");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    await run("schtasks.exe", ["/End", "/TN", "9codex"]);
    await killStaleDaemonLoops(run);
    await terminateWindowsDaemons(paths, run);
    rotateDaemonLog(paths);
    if (fs.existsSync(paths.serviceScript)) fs.unlinkSync(paths.serviceScript);
    const compileStatus = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      windowsLauncherCompilation(paths),
    ]);
    if (compileStatus !== 0) throw new Error("Unable to build 9codex Windows launcher");
    const status = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      windowsTaskRegistration(paths, nodePath, cliPath),
    ]);
    if (status !== 0) throw new Error("Unable to register 9codex scheduled task");
    return true;
  }
  if (platform === "darwin") {
    const wait = options.wait || waitDefault;
    rotateDaemonLog(paths);
    fs.mkdirSync(path.dirname(paths.servicePlist), { recursive: true });
    const domain = `gui/${process.getuid()}`;
    const service = `${domain}/ai.9codex.daemon`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>ai.9codex.daemon</string><key>ProgramArguments</key><array><string>${nodePath}</string><string>${cliPath}</string><string>daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${paths.daemonLog}</string><key>StandardErrorPath</key><string>${paths.daemonLog}</string></dict></plist>\n`;
    await run("/bin/launchctl", ["bootout", service], { capture: true });
    let loaded = true;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const result = await run("/bin/launchctl", ["print", service], { capture: true });
      loaded = commandStatus(result) === 0;
      if (!loaded) break;
      await wait(250);
    }
    if (loaded) throw new Error("Timed out waiting for the previous 9codex launch agent to unload");
    const temporaryPlist = `${paths.servicePlist}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPlist, xml, { mode: 0o600 });
    fs.renameSync(temporaryPlist, paths.servicePlist);
    const result = await run(
      "/bin/launchctl",
      ["bootstrap", domain, paths.servicePlist],
      { capture: true },
    );
    if (commandStatus(result) !== 0) {
      throw new Error(commandFailure("launchctl bootstrap", result));
    }
    let registered = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const verification = await run("/bin/launchctl", ["print", service], { capture: true });
      registered = commandStatus(verification) === 0;
      if (registered) break;
      await wait(250);
    }
    if (!registered) throw new Error("9codex launch agent was not loaded after registration");
    return true;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export async function restartService(paths, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || runDefault;
  if (platform === "win32") {
    await run("schtasks.exe", ["/End", "/TN", "9codex"]);
    await terminateWindowsDaemons(paths, run);
    await killStaleDaemonLoops(run);
    rotateDaemonLog(paths);
    const status = await run("schtasks.exe", ["/Run", "/TN", "9codex"]);
    if (status !== 0) throw new Error("Unable to restart 9codex scheduled task");
    return;
  }
  const status = await run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/ai.9codex.daemon`]);
  if (status !== 0) throw new Error("Unable to restart 9codex launch agent");
}

export async function uninstallService(paths, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || runDefault;
  if (platform === "win32") {
    await run("schtasks.exe", ["/End", "/TN", "9codex"]);
    await terminateWindowsDaemons(paths, run);
    await run("schtasks.exe", ["/Delete", "/TN", "9codex", "/F"]);
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$wrapperRoot = ${powershellLiteral(`${paths.stateDir}\\codex-wrapper-`)}; $current = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User'); if ($current -and $current.StartsWith($wrapperRoot) -and $current.EndsWith('.exe')) { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $null, 'User') }`,
    ]);
    if (fs.existsSync(paths.serviceScript)) fs.unlinkSync(paths.serviceScript);
    if (fs.existsSync(paths.serviceLauncher)) fs.unlinkSync(paths.serviceLauncher);
    return;
  }
  await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/ai.9codex.daemon`]);
  if (fs.existsSync(paths.servicePlist)) fs.unlinkSync(paths.servicePlist);
}
