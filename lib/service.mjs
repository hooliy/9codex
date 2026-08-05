import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function runDefault(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: options.inherit ? "inherit" : "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (status) => resolve(status));
  });
}

function waitDefault(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function windowsTaskRegistration(paths, nodePath, cliPath) {
  const daemonArgs = `${powershellLiteral(cliPath)} daemon --redirect-logs`;
  return [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(nodePath)} -Argument ${powershellLiteral(daemonArgs)} -WorkingDirectory ${powershellLiteral(paths.home)}`,
    "$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity",
    "$recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    "Register-ScheduledTask -TaskName '9codex' -Action $action -Trigger @($logonTrigger, $recoveryTrigger) -Principal $principal -Settings $settings -Force | Out-Null",
  ].join("; ");
}

async function terminateWindowsDaemons(paths, run) {
  const pid = recordedPid(paths);
  const script = [
    `$recordedPid = ${pid}`,
    "$pattern = '(?i)[\\\\/]node_modules[\\\\/]9codex[\\\\/].*9codex\\.mjs\"?\\s+daemon(?:\\s|$)'",
    "$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "foreach ($process in $processes) {",
    "  if ($process.CommandLine -match $pattern) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
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
    await killStaleDaemonLoops(run);
    await terminateWindowsDaemons(paths, run);
    rotateDaemonLog(paths);
    if (fs.existsSync(paths.serviceScript)) fs.unlinkSync(paths.serviceScript);
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
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>ai.9codex.daemon</string><key>ProgramArguments</key><array><string>${nodePath}</string><string>${cliPath}</string><string>daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${paths.daemonLog}</string><key>StandardErrorPath</key><string>${paths.daemonLog}</string></dict></plist>\n`;
    fs.writeFileSync(paths.servicePlist, xml);
    await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/ai.9codex.daemon`]);
    let status = -1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      status = await run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, paths.servicePlist]);
      if (status === 0) break;
      if (attempt < 4) await wait(250 * (2 ** attempt));
    }
    if (status !== 0) throw new Error("Unable to register 9codex launch agent");
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
    if (fs.existsSync(paths.serviceScript)) fs.unlinkSync(paths.serviceScript);
    return;
  }
  await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/ai.9codex.daemon`]);
  if (fs.existsSync(paths.servicePlist)) fs.unlinkSync(paths.servicePlist);
}
