import * as vscode from 'vscode';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../constants';

export class AuthManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(profileName?: string): Promise<string | undefined> {
    const value = await this.secrets.get(secretKey(profileName));
    return value?.trim() || undefined;
  }

  async hasApiKey(profileName?: string): Promise<boolean> {
    return Boolean(await this.getApiKey(profileName));
  }

  async promptForApiKey(profileName?: string): Promise<boolean> {
    const apiKey = await this.promptForApiKeyValue(profileName);
    if (!apiKey) return false;
    await this.storeApiKey(profileName, apiKey);
    const relayLabel = profileName ? `“${profileName}”` : 'Default Relay';
    vscode.window.showInformationMessage(`WeaveNet API key for ${relayLabel} saved.`);
    return true;
  }

  async promptForApiKeyValue(profileName?: string): Promise<string | undefined> {
    const relayLabel = profileName ? `“${profileName}”` : 'Default Relay';
    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter the API key for ${relayLabel}`,
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key is required'),
    });

    return apiKey?.trim() || undefined;
  }

  async storeApiKey(profileName: string | undefined, apiKey: string): Promise<void> {
    await this.secrets.store(secretKey(profileName), apiKey.trim());
  }

  async clearApiKey(profileName?: string): Promise<void> {
    if (profileName) await this.clearProfileApiKey(profileName);
    else await this.clearAllRelayApiKeys([]);
    const relayLabel = profileName ? `“${profileName}”` : 'Default Relay';
    vscode.window.showInformationMessage(`WeaveNet API key for ${relayLabel} cleared.`);
  }

  async moveApiKey(fromProfileName: string | undefined, toProfileName: string): Promise<boolean> {
    const fromKey = secretKey(fromProfileName);
    const toKey = secretKey(toProfileName);
    if (fromKey === toKey) return Boolean(await this.getApiKey(fromProfileName));

    const [apiKey, destinationValue] = await Promise.all([this.secrets.get(fromKey), this.secrets.get(toKey)]);
    if (destinationValue !== undefined) {
      throw new Error('The destination connection already has an API key. Clear it before renaming this connection.');
    }
    if (!apiKey?.trim()) return false;

    try {
      await this.secrets.store(toKey, apiKey);
      await this.secrets.delete(fromKey);
      return true;
    } catch (error) {
      await restoreSecret(this.secrets, fromKey, apiKey);
      await restoreSecret(this.secrets, toKey, destinationValue);
      throw error;
    }
  }

  async clearProfileApiKey(profileName: string): Promise<void> {
    await this.deleteSecretKeys([secretKey(profileName)]);
  }

  async clearAllRelayApiKeys(profileNames: readonly string[]): Promise<void> {
    await this.deleteSecretKeys([
      ...profileNames.map((profileName) => secretKey(profileName)),
      RELAY_API_KEY_SECRET,
      OPENAI_API_KEY_SECRET,
      LEGACY_API_KEY_SECRET,
      CHATGPT_API_KEY_SECRET,
      CLAUDE_API_KEY_SECRET,
    ]);
  }

  private async deleteSecretKeys(keys: readonly string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    const existing = await Promise.all(uniqueKeys.map(async (key) => ({ key, value: await this.secrets.get(key) })));
    const snapshots = existing.filter((entry): entry is { key: string; value: string } => entry.value !== undefined);
    try {
      for (const key of uniqueKeys) {
        await this.secrets.delete(key);
      }
    } catch (error) {
      for (const { key, value } of snapshots) {
        await Promise.resolve(this.secrets.store(key, value)).catch(() => undefined);
      }
      throw error;
    }
  }
}

function secretKey(profileName?: string): string {
  return profileName ? `${RELAY_API_KEY_SECRET}.profile.${encodeURIComponent(profileName)}` : RELAY_API_KEY_SECRET;
}

async function restoreSecret(secrets: vscode.SecretStorage, key: string, value: string | undefined): Promise<void> {
  if (value === undefined) {
    await secrets.delete(key);
  } else {
    await secrets.store(key, value);
  }
}
