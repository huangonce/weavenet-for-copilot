import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../src/constants';
import { LEGACY_RESET_MARKER, resetLegacyInstallation } from '../src/migration/legacyReset';

class InMemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

class InMemoryState {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe('legacy installation reset', () => {
  const settings = new Map<string, unknown>();
  const workspaceSettings = new Map<string, unknown>();
  const folderSettings = new Map<string, unknown>();

  beforeEach(() => {
    settings.clear();
    workspaceSettings.clear();
    folderSettings.clear();
    vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((_section?: string, resource?: { toString(): string }) => {
      const values = resource ? folderSettings : settings;
      return {
        inspect: <T>(key: string) => resource
          ? ({ workspaceFolderValue: values.get(key) as T | undefined })
          : ({ globalValue: settings.get(key) as T | undefined, workspaceValue: workspaceSettings.get(key) as T | undefined }),
        update: async (key: string, value: unknown, target?: vscode.ConfigurationTarget) => {
          const destination = target === vscode.ConfigurationTarget.Workspace
            ? workspaceSettings
            : target === vscode.ConfigurationTarget.WorkspaceFolder || resource
              ? folderSettings
              : settings;
          if (value === undefined) destination.delete(key);
          else destination.set(key, value);
        },
      } as never;
    });
    vi.stubGlobal('workspaceFolders', undefined);
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: undefined });
  });

  it('clears only pre-profile state and records a completion marker', async () => {
    const secrets = new InMemorySecrets();
    const globalState = new InMemoryState();
    settings.set('baseUrl', 'https://legacy.example.com/v1');
    settings.set('profiles', [{ name: 'Keep', baseUrl: 'https://keep.example.com/v1' }]);
    await secrets.store(RELAY_API_KEY_SECRET, 'legacy-default');
    await secrets.store(OPENAI_API_KEY_SECRET, 'legacy-openai');
    await secrets.store(`${RELAY_API_KEY_SECRET}.profile.Keep`, 'profile-key');

    const result = await resetLegacyInstallation({ secrets, globalState } as never);

    expect(result).toEqual({ cleaned: true, removedBaseUrl: true, removedSecretCount: 2 });
    expect(settings.get('baseUrl')).toBeUndefined();
    expect(settings.get('profiles')).toEqual([{ name: 'Keep', baseUrl: 'https://keep.example.com/v1' }]);
    expect(secrets.values.get(RELAY_API_KEY_SECRET)).toBeUndefined();
    expect(secrets.values.get(OPENAI_API_KEY_SECRET)).toBeUndefined();
    expect(secrets.values.get(`${RELAY_API_KEY_SECRET}.profile.Keep`)).toBe('profile-key');
    expect(globalState.get(LEGACY_RESET_MARKER)).toBe(true);
  });

  it('does not repeat the destructive cleanup after completion', async () => {
    const secrets = new InMemorySecrets();
    const globalState = new InMemoryState();
    await globalState.update(LEGACY_RESET_MARKER, true);
    settings.set('baseUrl', 'https://later.example.com/v1');
    await secrets.store(RELAY_API_KEY_SECRET, 'later-value');

    await expect(resetLegacyInstallation({ secrets, globalState } as never)).resolves.toEqual({
      cleaned: false,
      removedBaseUrl: false,
      removedSecretCount: 0,
    });
    expect(settings.get('baseUrl')).toBe('https://later.example.com/v1');
    expect(secrets.values.get(RELAY_API_KEY_SECRET)).toBe('later-value');
  });

  it('marks a clean installation without showing it as upgraded', async () => {
    const secrets = new InMemorySecrets();
    const globalState = new InMemoryState();

    await expect(resetLegacyInstallation({ secrets, globalState } as never)).resolves.toEqual({
      cleaned: false,
      removedBaseUrl: false,
      removedSecretCount: 0,
    });
    expect(globalState.get(LEGACY_RESET_MARKER)).toBe(true);
  });

  it('clears legacy Base URL values from global, workspace, and folder scopes', async () => {
    const secrets = new InMemorySecrets();
    const globalState = new InMemoryState();
    settings.set('baseUrl', 'https://global.example.com/v1');
    workspaceSettings.set('baseUrl', 'https://workspace.example.com/v1');
    folderSettings.set('baseUrl', 'https://folder.example.com/v1');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      value: [{ uri: { toString: () => 'file:///workspace/folder' } }],
    });

    await expect(resetLegacyInstallation({ secrets, globalState } as never)).resolves.toMatchObject({
      cleaned: true,
      removedBaseUrl: true,
    });
    expect(settings.get('baseUrl')).toBeUndefined();
    expect(workspaceSettings.get('baseUrl')).toBeUndefined();
    expect(folderSettings.get('baseUrl')).toBeUndefined();
    expect(globalState.get(LEGACY_RESET_MARKER)).toBe(true);
  });
});