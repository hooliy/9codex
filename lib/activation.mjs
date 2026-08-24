import { reconcileModelState, validateModelState } from "./model-state.mjs";

export async function activateInstallation(paths, config, dependencies) {
  validateModelState(paths, config);
  await dependencies.installService();
  await dependencies.restartService();
  const health = await dependencies.waitForHealth(config);
  if (
    !health?.ok
    || !health.ready
    || !Number.isInteger(health.model_count)
    || health.model_count < 1
  ) {
    throw new Error("9codex service did not become ready with at least one model");
  }
  return { health };
}

export async function reconcileAndActivateInstallation(paths, config, dependencies) {
  const reconciled = await reconcileModelState(paths, config, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
  });
  return activateInstallation(paths, reconciled.config, dependencies);
}
