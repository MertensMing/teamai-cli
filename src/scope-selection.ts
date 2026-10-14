import {
  saveLocalConfig,
  saveLocalConfigForScope,
  loadStateForScope,
  saveStateForScope,
} from './config.js';
import type { LocalConfig } from './types.js';

/**
 * Write a role or project selection to the scope it belongs to, and make the
 * next pull a full sync so it cleans up what the old selection delivered.
 * Shared by `roles set`, `projects set`, and the dashboard's Distribution
 * page (#1124). Never runs pull and never touches the team repo.
 */
export async function saveScopeSelection(localConfig: LocalConfig, updatedConfig: LocalConfig): Promise<void> {
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    await saveLocalConfigForScope(updatedConfig, localConfig.scope, localConfig.projectRoot);
  } else {
    await saveLocalConfig(updatedConfig);
  }

  try {
    const state = await loadStateForScope(localConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, localConfig);
  } catch {
    // Non-critical: a missing state file means the next pull is a full sync anyway.
  }
}
