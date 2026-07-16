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

interface BaseUrlSnapshot {
  readonly configuration: vscode.WorkspaceConfiguration;
  readonly target: vscode.ConfigurationTarget;
  readonly value: string;
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
  const baseUrlSnapshots = collectBaseUrlSnapshots(configuration);
  const inspectedSecrets = await Promise.all(legacySecretKeys.map(async (key) => ({
    key,
    value: await context.secrets.get(key),
  })));
  const secretSnapshots = inspectedSecrets.flatMap(({ key, value }) => value === undefined ? [] : [{ key, value }]);

  try {
    for (const snapshot of baseUrlSnapshots) {
      await snapshot.configuration.update('baseUrl', undefined, snapshot.target);
    }
    for (const key of legacySecretKeys) {
      await context.secrets.delete(key);
    }
    await context.globalState.update(LEGACY_RESET_MARKER, true);
  } catch (error) {
    for (const snapshot of baseUrlSnapshots) {
      await Promise.resolve(snapshot.configuration.update('baseUrl', snapshot.value, snapshot.target)).catch(() => undefined);
    }
    for (const { key, value } of secretSnapshots) {
      await Promise.resolve(context.secrets.store(key, value)).catch(() => undefined);
    }
    throw error;
  }

  return {
    cleaned: baseUrlSnapshots.length > 0 || secretSnapshots.length > 0,
    removedBaseUrl: baseUrlSnapshots.length > 0,
    removedSecretCount: secretSnapshots.length,
  };
}

function collectBaseUrlSnapshots(configuration: vscode.WorkspaceConfiguration): BaseUrlSnapshot[] {
  const snapshots: BaseUrlSnapshot[] = [];
  const inspected = configuration.inspect<string>('baseUrl');
  if (inspected?.globalValue !== undefined) {
    snapshots.push({ configuration, target: vscode.ConfigurationTarget.Global, value: inspected.globalValue });
  }
  if (inspected?.workspaceValue !== undefined) {
    snapshots.push({ configuration, target: vscode.ConfigurationTarget.Workspace, value: inspected.workspaceValue });
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
    const value = folderConfiguration.inspect<string>('baseUrl')?.workspaceFolderValue;
    if (value !== undefined) {
      snapshots.push({ configuration: folderConfiguration, target: vscode.ConfigurationTarget.WorkspaceFolder, value });
    }
  }
  return snapshots;
}