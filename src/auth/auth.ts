import * as vscode from 'vscode';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
} from '../constants';

export type ApiKeyKind = 'openai' | 'chatgpt' | 'claude';

const SECRET_KEYS: Record<ApiKeyKind, string> = {
  openai: OPENAI_API_KEY_SECRET,
  chatgpt: CHATGPT_API_KEY_SECRET,
  claude: CLAUDE_API_KEY_SECRET,
};

const LABELS: Record<ApiKeyKind, string> = {
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
};

export class AuthManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(kind: ApiKeyKind): Promise<string | undefined> {
    const value = await this.secrets.get(SECRET_KEYS[kind]);
    if (value?.trim()) {
      return value.trim();
    }

    if (kind === 'openai') {
      const legacyValue = await this.secrets.get(LEGACY_API_KEY_SECRET);
      return legacyValue?.trim() || undefined;
    }

    return value?.trim() || undefined;
  }

  async hasApiKey(kind: ApiKeyKind): Promise<boolean> {
    return Boolean(await this.getApiKey(kind));
  }

  async promptForApiKey(kind: ApiKeyKind): Promise<boolean> {
    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter your WeaveNet ${LABELS[kind]} group API key`,
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key is required'),
    });

    if (!apiKey) {
      return false;
    }

    await this.secrets.store(SECRET_KEYS[kind], apiKey.trim());
    vscode.window.showInformationMessage(`WeaveNet ${LABELS[kind]} API key saved.`);
    return true;
  }

  async clearApiKey(kind: ApiKeyKind): Promise<void> {
    await this.secrets.delete(SECRET_KEYS[kind]);
    if (kind === 'openai') {
      await this.secrets.delete(LEGACY_API_KEY_SECRET);
    }
    vscode.window.showInformationMessage(`WeaveNet ${LABELS[kind]} API key cleared.`);
  }
}
