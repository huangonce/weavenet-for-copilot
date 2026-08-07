import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  CATALOG_ARTIFACT_PEPPER_SECRET,
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../constants';
import type { ConnectionProfile } from '../config/config';

type AuthProfile = Pick<ConnectionProfile, 'id' | 'name'>;

export class AuthManager {
  private catalogArtifactPepperTask: Promise<string> | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(profile: AuthProfile): Promise<string | undefined> {
    const value = await this.secrets.get(secretKey(profile))
      ?? await this.secrets.get(legacyProfileSecretKey(profile.name));
    return value?.trim() || undefined;
  }

  async hasApiKey(profile: AuthProfile): Promise<boolean> {
    return Boolean(await this.getApiKey(profile));
  }

  /**
   * Installation-local secret used to key persisted catalog identities. If
   * SecretStorage is temporarily unavailable, the process-local fallback is
   * still safe; it merely prevents restoration on the next activation.
   */
  getCatalogArtifactPepper(): Promise<string> {
    this.catalogArtifactPepperTask ??= this.loadOrCreateCatalogArtifactPepper();
    return this.catalogArtifactPepperTask;
  }

  async promptForApiKeyValue(profileName: string): Promise<string | undefined> {
    const relayLabel = `“${profileName}”`;
    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter the API key for ${relayLabel}`,
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key is required'),
    });

    return apiKey?.trim() || undefined;
  }

  async storeApiKey(profile: AuthProfile, apiKey: string): Promise<void> {
    await this.secrets.store(secretKey(profile), apiKey.trim());
  }

  async clearProfileApiKey(profile: AuthProfile): Promise<void> {
    await this.deleteSecretKeys([secretKey(profile), legacyProfileSecretKey(profile.name)]);
  }

  async clearAllRelayApiKeys(profiles: readonly AuthProfile[]): Promise<void> {
    await this.deleteSecretKeys([
      ...profiles.flatMap((profile) => [secretKey(profile), legacyProfileSecretKey(profile.name)]),
      RELAY_API_KEY_SECRET,
      OPENAI_API_KEY_SECRET,
      LEGACY_API_KEY_SECRET,
      CHATGPT_API_KEY_SECRET,
      CLAUDE_API_KEY_SECRET,
    ]);
  }

  async migrateProfileApiKeys(profiles: readonly AuthProfile[]): Promise<void> {
    for (const profile of profiles) await this.migrateProfileApiKey(profile);
  }

  private async migrateProfileApiKey(profile: AuthProfile): Promise<void> {
    const targetKey = secretKey(profile);
    const sourceKey = legacyProfileSecretKey(profile.name);
    const [target, source] = await Promise.all([this.secrets.get(targetKey), this.secrets.get(sourceKey)]);
    if (target !== undefined || !source?.trim()) return;
    try {
      await this.secrets.store(targetKey, source);
      if (await this.secrets.get(targetKey) !== source) throw new Error('Could not verify the migrated API key.');
      await this.secrets.delete(sourceKey);
    } catch {
      await restoreSecret(this.secrets, targetKey, target);
      // Keep the legacy source intact so getApiKey can continue to use it.
      await restoreSecret(this.secrets, sourceKey, source);
    }
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

  private async loadOrCreateCatalogArtifactPepper(): Promise<string> {
    try {
      const existing = await this.secrets.get(CATALOG_ARTIFACT_PEPPER_SECRET);
      if (isCatalogArtifactPepper(existing)) return existing;
    } catch {
      return newCatalogArtifactPepper();
    }
    const generated = newCatalogArtifactPepper();
    try {
      await this.secrets.store(CATALOG_ARTIFACT_PEPPER_SECRET, generated);
    } catch {
      // Keep the generated value for this process. Persisted cache entries
      // will simply become unreadable after restart, never cross credentials.
    }
    return generated;
  }
}

export function profileSecretKey(profileId: string): string {
  return `${RELAY_API_KEY_SECRET}.profileId.${profileId}`;
}

function secretKey(profile: AuthProfile): string {
  return profileSecretKey(profile.id);
}

function legacyProfileSecretKey(profileName: string): string {
  return `${RELAY_API_KEY_SECRET}.profile.${encodeURIComponent(profileName)}`;
}

async function restoreSecret(secrets: vscode.SecretStorage, key: string, value: string | undefined): Promise<void> {
  if (value === undefined) {
    await secrets.delete(key);
  } else {
    await secrets.store(key, value);
  }
}

function newCatalogArtifactPepper(): string {
  return randomBytes(32).toString('base64url');
}

function isCatalogArtifactPepper(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
