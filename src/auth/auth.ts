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
    const relayLabel = profileName ? `“${profileName}”` : 'Default Relay';
    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter the API key for ${relayLabel}`,
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key is required'),
    });

    if (!apiKey) {
      return false;
    }

    await this.secrets.store(secretKey(profileName), apiKey.trim());
    vscode.window.showInformationMessage(`WeaveNet API key for ${relayLabel} saved.`);
    return true;
  }

  async clearApiKey(profileName?: string): Promise<void> {
    if (profileName) await this.clearProfileApiKey(profileName);
    else await this.clearAllRelayApiKeys([]);
    const relayLabel = profileName ? `“${profileName}”` : 'Default Relay';
    vscode.window.showInformationMessage(`WeaveNet API key for ${relayLabel} cleared.`);
  }

  async moveApiKey(fromProfileName: string | undefined, toProfileName: string): Promise<boolean> {
    const apiKey = await this.getApiKey(fromProfileName);
    if (!apiKey) return false;
    await this.secrets.store(secretKey(toProfileName), apiKey);
    await this.secrets.delete(secretKey(fromProfileName));
    return true;
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
      await Promise.all(uniqueKeys.map((key) => this.secrets.delete(key)));
    } catch (error) {
      await Promise.all(snapshots.map(({ key, value }) => Promise.resolve(this.secrets.store(key, value)).catch(() => undefined)));
      throw error;
    }
  }
}

function secretKey(profileName?: string): string {
  return profileName ? `${RELAY_API_KEY_SECRET}.profile.${encodeURIComponent(profileName)}` : RELAY_API_KEY_SECRET;
}
