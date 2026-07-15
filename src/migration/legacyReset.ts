import * as vscode from 'vscode';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  CONFIG_SECTION,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../constants';

export const LEGACY_RESET_MARKER = 'weavenet-copilot.legacyReset.v1Completed';

const legacySecretKeys = [
  RELAY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
] as const;

export interface LegacyResetResult {
  readonly cleaned: boolean;
  readonly removedBaseUrl: boolean;
  readonly removedSecretCount: number;
}

/**
 * Removes the pre-profile connection state once. Profile configuration and
 * profile-scoped secrets are deliberately outside this cleanup boundary.
 */
export async function resetLegacyInstallation(context: vscode.ExtensionContext): Promise<LegacyResetResult> {
  if (context.globalState.get<boolean>(LEGACY_RESET_MARKER)) {
    return { cleaned: false, removedBaseUrl: false, removedSecretCount: 0 };
  }

  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const previousBaseUrl = configuration.inspect<string>('baseUrl')?.globalValue;
  const inspectedSecrets = await Promise.all(legacySecretKeys.map(async (key) => ({
    key,
    value: await context.secrets.get(key),
  })));
  const secretSnapshots = inspectedSecrets.flatMap(({ key, value }) => value === undefined ? [] : [{ key, value }]);

  try {
    if (previousBaseUrl !== undefined) {
      await configuration.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
    }
    await Promise.all(legacySecretKeys.map((key) => context.secrets.delete(key)));
    await context.globalState.update(LEGACY_RESET_MARKER, true);
  } catch (error) {
    if (previousBaseUrl !== undefined) {
      await Promise.resolve(configuration.update('baseUrl', previousBaseUrl, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    }
    await Promise.all(secretSnapshots.map(({ key, value }) => Promise.resolve(context.secrets.store(key, value)).catch(() => undefined)));
    throw error;
  }

  return {
    cleaned: previousBaseUrl !== undefined || secretSnapshots.length > 0,
    removedBaseUrl: previousBaseUrl !== undefined,
    removedSecretCount: secretSnapshots.length,
  };
}