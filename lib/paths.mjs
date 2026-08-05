import path from "node:path";

export function resolvePaths(home) {
  const stateDir = path.join(home, ".9codex");
  const codexHome = path.join(home, ".codex");
  return {
    home,
    stateDir,
    config: path.join(stateDir, "config.json"),
    pendingConfig: path.join(stateDir, "config.pending.json"),
    lastGoodConfig: path.join(stateDir, "config.last-good.json"),
    legacyConfig: path.join(home, ".codex-9router", "config.json"),
    codexHome,
    codexConfig: path.join(codexHome, "config.toml"),
    codexStateDb: path.join(codexHome, "state_5.sqlite"),
    codexLegacyStateDb: path.join(codexHome, "sqlite", "state_5.sqlite"),
    codexState: path.join(stateDir, "codex-state.json"),
    historyProviderState: path.join(stateDir, "codex-history-providers.json"),
    catalog: path.join(stateDir, "9codex-model-catalog.json"),
    modelMap: path.join(stateDir, "model-map.json"),
    commandState: path.join(stateDir, "commands.json"),
    daemonPid: path.join(stateDir, "daemon.pid"),
    desktopSession: path.join(stateDir, "desktop-session.json"),
    serviceScript: path.join(stateDir, "service.cmd"),
    serviceLauncher: path.join(stateDir, "9codex-service-launcher.exe"),
    servicePlist: path.join(home, "Library", "LaunchAgents", "ai.9codex.daemon.plist"),
    daemonLog: path.join(stateDir, "logs", "daemon.log"),
    logDir: path.join(stateDir, "logs"),
    versionsDir: path.join(stateDir, "versions"),
    imagesDir: path.join(stateDir, "images"),
  };
}
