import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  addConnection,
  clearActiveRelayKey,
  clearAllConnections,
  configureActiveRelay,
  copyConnection,
  deleteConnection,
  editConnection,
  errorMessage,
  formatConnectionFailure,
  queueConnectionMutation,
  renderStatus,
  saveProfiles,
  setDefaultConnection,
  testConnection,
  validateProfileName,
} from '../src/extension';
import type { ConnectionProfile } from '../src/config/config';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_ID = '22222222-2222-4222-8222-222222222222';
const WORK_PROFILE: ConnectionProfile = { id: WORK_ID, name: 'Work', baseUrl: 'https://work.example.test/v1' };
const PERSONAL_PROFILE: ConnectionProfile = { id: PERSONAL_ID, name: 'Personal', baseUrl: 'https://personal.example.test/v1' };

function configurationFixture(initialProfiles: ConnectionProfile[] = [WORK_PROFILE]) {
  let profiles = initialProfiles;
  const update = vi.fn(async (key: string, value: unknown) => {
    if (key === 'profiles') profiles = (value ?? []) as ConnectionProfile[];
  });
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: <T>() => undefined as T | undefined,
    inspect: <T>(key: string) => key === 'profiles' ? { globalValue: profiles as T } : undefined,
    update,
  } as never);
  return { get profiles() { return profiles; }, update };
}

function providerFixture(overrides: Record<string, unknown> = {}) {
  return {
    promptForRelayKeyValue: vi.fn().mockResolvedValue('new-key'),
    storeRelayKey: vi.fn().mockResolvedValue(undefined),
    clearRelayKeyForProfile: vi.fn().mockResolvedValue(undefined),
    clearAllRelayKeys: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({
      schemaVersion: 2,
      profileId: WORK_ID,
      fingerprint: 'a'.repeat(64),
      connectionName: 'Work',
      host: 'relay.example.test',
      testedAt: 1,
      completedAt: 11,
      modelCount: 2,
      elapsedMs: 10,
      overall: 'success',
      capabilities: {
        openai: { nonStreaming: 'supported', streaming: 'supported', mode: 'streaming' },
        claude: { nonStreaming: 'skipped', streaming: 'skipped', mode: 'unknown' },
      },
      probes: [{ probe: 'models', verdict: 'supported', endpointPath: '/models', startedAt: 1, elapsedMs: 2, status: 200, responseType: 'application/json' }],
    }),
    clearConnectionDiagnostics: vi.fn().mockResolvedValue(undefined),
    clearAllConnectionDiagnostics: vi.fn().mockResolvedValue(undefined),
    logMetadata: vi.fn(),
    refreshModels: vi.fn().mockResolvedValue(undefined),
    refreshConnection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

function pickProfile(profile: ConnectionProfile): void {
  vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ profile } as never);
}

afterEach(() => vi.restoreAllMocks());

describe('connection mutation queue', () => {
  it('runs queued mutations strictly in order and continues after failures', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queueConnectionMutation(Promise.resolve(), async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
      throw new Error('first failed');
    });
    const second = queueConnectionMutation(first.next, async () => {
      order.push('second');
      return 'completed';
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst?.();
    await expect(first.result).rejects.toThrow('first failed');
    await expect(second.result).resolves.toBe('completed');
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('validates safe and unique connection names', () => {
    const profiles = [WORK_PROFILE];
    expect(validateProfileName('   ', profiles)).toBe('Connection name is required.');
    expect(validateProfileName('Work', profiles)).toBe('A connection with this name already exists.');
    expect(validateProfileName('Personal', profiles)).toBeUndefined();
    expect(validateProfileName('bad\nname', profiles)).toContain('control characters');
    expect(validateProfileName('x'.repeat(101), profiles)).toContain('100 characters');
  });

  it('renders aggregate connection states with per-connection details', () => {
    const item = { text: '', tooltip: '' } as never;
    renderStatus(item, {
      phase: 'unconfigured', connectionCount: 0, modelCount: 0, warningCount: 0, refreshingCount: 0, connections: [],
    });
    expect(item.text).toContain('Add Relay Connection');

    renderStatus(item, {
      phase: 'refreshing', connectionCount: 2, modelCount: 1, warningCount: 1, refreshingCount: 1,
      connections: [
        { profileId: WORK_ID, connectionName: 'Work', host: 'work.example.test', phase: 'ready', modelCount: 1 },
        { profileId: PERSONAL_ID, connectionName: 'Personal', host: 'personal.example.test', phase: 'refreshing', modelCount: 0 },
      ],
    });
    expect(item.text).toContain('2 connections');
    expect(item.text).toContain('refreshing');
    expect(item.tooltip).toContain('Work (work.example.test)');
    expect(item.tooltip).toContain('Personal (personal.example.test)');

    renderStatus(item, {
      phase: 'degraded', connectionCount: 2, modelCount: 3, warningCount: 1, refreshingCount: 0,
      connections: [
        { profileId: WORK_ID, connectionName: 'Work', phase: 'ready', modelCount: 3 },
        { profileId: PERSONAL_ID, connectionName: 'Personal', phase: 'error', modelCount: 0, message: 'offline' },
      ],
    });
    expect(item.text).toContain('3 models');
    expect(item.text).toContain('1 warning');
    expect(item.tooltip).toContain('offline');
  });

  it('formats structured failures without losing request diagnostics', () => {
    expect(formatConnectionFailure({ category: 'authentication', message: 'denied', status: 401, responseType: 'json', requestId: 'req-1' }))
      .toBe('Category: authentication\nHTTP status: 401\nResponse type: json\nRequest ID: req-1');
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage('failed')).toBe('Unknown error.');
  });

  it('creates a UUID connection and stores its key against that profile', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');

    await addConnection(provider);

    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0]).toMatchObject({ name: 'Personal', baseUrl: 'https://personal.example.test/v1' });
    expect(config.profiles[0].id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(provider.storeRelayKey).toHaveBeenCalledWith(config.profiles[0], 'new-key');
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('rolls profile creation back and deletes its UUID key when secret storage fails', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture({ storeRelayKey: vi.fn().mockRejectedValue(new Error('secret failure')) });
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');
    const showError = vi.spyOn(vscode.window, 'showErrorMessage');

    await addConnection(provider);

    expect(config.profiles).toEqual([]);
    const failedProfile = provider.storeRelayKey.mock.calls[0][0];
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith(failedProfile);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('secret failure'));
  });

  it('deletes a connection and always deletes its UUID-scoped key', async () => {
    const config = configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const provider = providerFixture();
    pickProfile(WORK_PROFILE);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete Connection and API Key' as never);

    await deleteConnection(provider);

    expect(config.profiles).toEqual([PERSONAL_PROFILE]);
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith(WORK_PROFILE);
    expect(provider.clearConnectionDiagnostics).toHaveBeenCalledWith(WORK_PROFILE);
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('rolls deletion back if key deletion fails but does not roll back for diagnostic cleanup failures', async () => {
    const config = configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const provider = providerFixture({ clearRelayKeyForProfile: vi.fn().mockRejectedValue(new Error('secret delete failed')) });
    pickProfile(WORK_PROFILE);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete Connection and API Key' as never);

    await deleteConnection(provider);
    expect(config.profiles).toEqual([WORK_PROFILE, PERSONAL_PROFILE]);
    expect(provider.refreshModels).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const cleanupConfig = configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const cleanupProvider = providerFixture({ clearConnectionDiagnostics: vi.fn().mockRejectedValue(new Error('memento failure')) });
    pickProfile(WORK_PROFILE);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete Connection and API Key' as never);
    await deleteConnection(cleanupProvider);
    expect(cleanupConfig.profiles).toEqual([PERSONAL_PROFILE]);
    expect(cleanupProvider.logMetadata).toHaveBeenCalledWith(expect.stringContaining('memento failure'));
  });

  it('clears all current profiles, keys, and diagnostics after confirmation', async () => {
    const config = configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Clear All Connections' as never);

    await clearAllConnections(provider);

    expect(config.profiles).toEqual([]);
    expect(provider.clearAllRelayKeys).toHaveBeenCalledWith([WORK_PROFILE, PERSONAL_PROFILE]);
    expect(provider.clearAllConnectionDiagnostics).toHaveBeenCalledOnce();
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('keeps legacy default commands compatible without changing routing state', async () => {
    const config = configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const provider = providerFixture();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await setDefaultConnection(provider);

    expect(info).toHaveBeenCalledWith(
      'All WeaveNet connections are enabled simultaneously; a default connection is no longer required.',
      'Manage Connections',
    );
    expect(config.update).not.toHaveBeenCalled();
    expect(provider.refreshModels).not.toHaveBeenCalled();
  });

  it('edits a connection while preserving its UUID and key identity', async () => {
    const config = configurationFixture([WORK_PROFILE]);
    const provider = providerFixture();
    pickProfile(WORK_PROFILE);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Company')
      .mockResolvedValueOnce('https://company.example.test/v1')
      .mockResolvedValueOnce('{"X-Tenant":"team-a"}')
      .mockResolvedValueOnce('{"includeModels":["gpt"],"excludeModels":["legacy"]}')
      .mockResolvedValueOnce('[{"id":"gpt-test","route":"openai"}]');

    await editConnection(provider);

    expect(config.profiles).toEqual([{
      id: WORK_ID,
      name: 'Company',
      baseUrl: 'https://company.example.test/v1',
      requestHeaders: { 'X-Tenant': 'team-a' },
      includeModels: ['gpt'],
      excludeModels: ['legacy'],
      models: [{ id: 'gpt-test', route: 'openai' }],
    }]);
    expect(provider.clearConnectionDiagnostics).toHaveBeenCalledWith(WORK_PROFILE);
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('copies settings under a new UUID without copying or probing an API key', async () => {
    const config = configurationFixture([WORK_PROFILE]);
    const provider = providerFixture();
    pickProfile(WORK_PROFILE);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Work copy');

    await copyConnection(provider);

    expect(config.profiles).toHaveLength(2);
    expect(config.profiles[1]).toMatchObject({ name: 'Work copy', baseUrl: WORK_PROFILE.baseUrl });
    expect(config.profiles[1].id).not.toBe(WORK_ID);
    expect(provider.storeRelayKey).not.toHaveBeenCalled();
    expect(provider.clearRelayKeyForProfile).not.toHaveBeenCalled();
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('shows per-profile connection test diagnostics and structured failures', async () => {
    configurationFixture([WORK_PROFILE]);
    const provider = providerFixture();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items: readonly { profile: unknown }[]) => items[0] as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await testConnection(provider);

    expect(pick).toHaveBeenCalledOnce();
    expect(provider.testConnection).toHaveBeenCalledWith(WORK_PROFILE);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('connection test success'),
      expect.objectContaining({ detail: expect.stringContaining('models: supported') }),
    );

    provider.testConnection.mockRejectedValueOnce(new Error('offline'));
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await testConnection(provider);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Connection failed.'),
      expect.objectContaining({ detail: 'Category: unknown' }),
    );
  });

  it('creates a connection when setting a key with an empty pool', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');

    await configureActiveRelay(provider);

    expect(config.profiles).toHaveLength(1);
    expect(provider.storeRelayKey).toHaveBeenCalledWith(config.profiles[0], 'new-key');
  });

  it('selects among multiple profiles when setting or clearing a key and refreshes only that connection', async () => {
    configurationFixture([WORK_PROFILE, PERSONAL_PROFILE]);
    const provider = providerFixture();
    const pick = vi.spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce({ profile: PERSONAL_PROFILE } as never)
      .mockResolvedValueOnce({ profile: WORK_PROFILE } as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await configureActiveRelay(provider);
    expect(provider.storeRelayKey).toHaveBeenCalledWith(PERSONAL_PROFILE, 'new-key');
    expect(provider.refreshConnection).toHaveBeenCalledWith(PERSONAL_ID);

    await clearActiveRelayKey(provider);
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith(WORK_PROFILE);
    expect(provider.refreshConnection).toHaveBeenCalledWith(WORK_ID);
    expect(info).toHaveBeenCalledWith('WeaveNet API key for “Work” cleared.');
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('reports an empty connection pool when clearing a key', async () => {
    configurationFixture([]);
    const provider = providerFixture();
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await clearActiveRelayKey(provider);

    expect(info).toHaveBeenCalledWith('WeaveNet has no Relay connection API key to clear.');
    expect(provider.clearRelayKeyForProfile).not.toHaveBeenCalled();
  });

  it('saves only the UUID profile array and never writes activeProfile', async () => {
    const config = configurationFixture([]);
    await saveProfiles([WORK_PROFILE]);
    expect(config.profiles).toEqual([WORK_PROFILE]);
    expect(config.update).toHaveBeenCalledOnce();
    expect(config.update).toHaveBeenCalledWith('profiles', [WORK_PROFILE], vscode.ConfigurationTarget.Global);
  });
});
