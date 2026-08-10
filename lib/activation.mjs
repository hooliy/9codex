import { reconcileModelState, validateModelState } from "./model-state.mjs";

export async function activateInstallation(paths, config, dependencies) {
  validateModelState(paths, config);
  await dependencies.installService();
  await dependencies.restartService();
  const health = await dependencies.waitForHealth(config);
  if (!health?.ok || !health.ready) throw new Error("9codex service did not become ready");
  const skills = dependencies.syncSkills();
  let codex;
  try {
    codex = await dependencies.restartCodex(config);
  } catch (error) {
    await dependencies.configureCodex?.(config);
    codex = { codex_restarted: false, error: error.message };
  }
  return { health, skills, codex };
}

export async function reconcileAndActivateInstallation(paths, config, dependencies) {
  const reconciled = await reconcileModelState(paths, config, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
  });
  return activateInstallation(paths, reconciled.config, dependencies);
}
