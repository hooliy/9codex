import path from "node:path";

export function resolvePaths(home) {
  const stateDir = path.join(home, ".9codex");
  return {
    home,
    stateDir,
    config: path.join(stateDir, "config.json"),
    pendingConfig: path.join(stateDir, "config.pending.json"),
    lastGoodConfig: path.join(stateDir, "config.last-good.json"),
    catalog: path.join(stateDir, "9codex-model-catalog.json"),
    modelMap: path.join(stateDir, "model-map.json"),
    commandState: path.join(stateDir, "commands.json"),
    daemonPid: path.join(stateDir, "daemon.pid"),
    pendingUpdate: path.join(stateDir, "pending-update.json"),
    updateLock: path.join(stateDir, "update.lock"),
    serviceScript: path.join(stateDir, "service.cmd"),
    serviceLauncher: path.join(stateDir, "9codex-service-launcher.exe"),
    servicePlist: path.join(home, "Library", "LaunchAgents", "ai.9codex.daemon.plist"),
    daemonLog: path.join(stateDir, "logs", "daemon.log"),
    logDir: path.join(stateDir, "logs"),
    versionsDir: path.join(stateDir, "versions"),
    imagesDir: path.join(stateDir, "images"),
    codexWrapperArgs: path.join(stateDir, "codex-wrapper.args"),
    codexWrapperCurrent: path.join(stateDir, "codex-wrapper.current"),
  };
}
