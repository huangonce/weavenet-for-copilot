import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { addConnection, clearActiveRelayKey, clearAllConnections, configureActiveRelay, copyConnection, deleteConnection, editConnection, errorMessage, formatConnectionFailure, parseSingleProfile, queueConnectionMutation, renderStatus, saveProfiles, setDefaultConnection, testConnection, validateProfileName } from '../src/extension';

function configurationFixture(initialProfiles = [{ name: 'Work', baseUrl: 'https://work.example.test/v1' }], initialActiveProfile = 'Work') {
  let profiles = initialProfiles;
  let activeProfile = initialActiveProfile;
  const update = vi.fn(async (key: string, value: unknown) => {
    if (key === 'profiles') profiles = (value ?? []) as typeof profiles;
    if (key === 'activeProfile') activeProfile = (value ?? '') as string;
  });
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    inspect: <T>(key: string) => key === 'profiles'
      ? { globalValue: profiles as T }
      : key === 'activeProfile'
        ? { globalValue: activeProfile as T }
        : undefined,
    update,
  } as never);
  return { get profiles() { return profiles; }, get activeProfile() { return activeProfile; }, update };
}

function providerFixture(overrides: Record<string, unknown> = {}) {
  return {
    promptForRelayKeyValue: vi.fn().mockResolvedValue('new-key'),
    storeRelayKey: vi.fn().mockResolvedValue(undefined),
    clearRelayKeyForProfile: vi.fn().mockResolvedValue(undefined),
    clearAllRelayKeys: vi.fn().mockResolvedValue(undefined),
    hasRelayKey: vi.fn().mockResolvedValue(false),
    moveRelayKey: vi.fn().mockResolvedValue(true),
    testConnection: vi.fn().mockResolvedValue({
      host: 'relay.example.test', modelCount: 2, elapsedMs: 10, endpoint: 'https://relay.example.test/v1/models',
      models: { status: 200, responseType: 'json' },
    }),
    refreshModels: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe('connection mutation queue', () => {
  it('runs queued configuration and secret mutations strictly in order', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queueConnectionMutation(Promise.resolve(), async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = queueConnectionMutation(first.next, async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first.result, second.result]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues processing later mutations when an earlier mutation fails', async () => {
    const first = queueConnectionMutation(Promise.resolve(), async () => {
      throw new Error('first failed');
    });
    const second = queueConnectionMutation(first.next, async () => 'completed');

    await expect(first.result).rejects.toThrow('first failed');
    await expect(second.result).resolves.toBe('completed');
  });

  it('validates unique connection names and parses exactly one safe profile', () => {
    const profiles = [{ name: 'Work', baseUrl: 'https://work.example.test/v1' }];
    expect(validateProfileName('   ', profiles)).toBe('Connection name is required.');
    expect(validateProfileName('Work', profiles)).toBe('A connection with this name already exists.');
    expect(validateProfileName('Personal', profiles)).toBeUndefined();
    expect(validateProfileName('bad\nname', profiles)).toContain('control characters');
    expect(validateProfileName('x'.repeat(101), profiles)).toContain('100 characters');
    expect(parseSingleProfile('{"name":"Personal","baseUrl":"https://personal.example.test/v1"}', 'Work', profiles))
      .toEqual({ name: 'Personal', baseUrl: 'https://personal.example.test/v1' });
    expect(parseSingleProfile('{"name":"Work","baseUrl":"not a URL"}', 'Work', profiles)).toBeUndefined();
    expect(parseSingleProfile('{"name":"Work","baseUrl":"https://other.example.test/v1"}', 'Other', profiles)).toBeUndefined();
    expect(parseSingleProfile('{', 'Work', profiles)).toBeUndefined();
  });

  it('renders every connection state with a useful label and tooltip', () => {
    const item = { text: '', tooltip: '' } as never;
    renderStatus(item, { phase: 'unconfigured', modelCount: 0 });
    expect(item.text).toContain('Add Relay Connection');
    renderStatus(item, { connectionName: 'Work', host: 'relay.example.test', phase: 'keyMissing', modelCount: 0 });
    expect(item.text).toContain('API key required');
    renderStatus(item, { connectionName: 'Work', phase: 'refreshing', modelCount: 2 });
    expect(item.text).toContain('refreshing');
    renderStatus(item, { connectionName: 'Work', host: 'relay.example.test', phase: 'ready', modelCount: 3 });
    expect(item.text).toContain('3 models');
    expect(item.tooltip).toContain('relay.example.test');
    renderStatus(item, { connectionName: 'Work', phase: 'error', modelCount: 0, message: 'denied' });
    expect(item.text).toContain('denied');
  });

  it('formats structured failures without losing request diagnostics', () => {
    expect(formatConnectionFailure({ category: 'authentication', message: 'denied', status: 401, responseType: 'json', requestId: 'req-1' }))
      .toBe('Category: authentication\nHTTP status: 401\nResponse type: json\nRequest ID: req-1');
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage('failed')).toBe('Unknown error.');
  });

  it('creates and activates a connection before saving its profile-scoped key', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');

    await addConnection(provider);

    expect(config.profiles).toEqual([{ name: 'Personal', baseUrl: 'https://personal.example.test/v1' }]);
    expect(config.activeProfile).toBe('Personal');
    expect(provider.storeRelayKey).toHaveBeenCalledWith('Personal', 'new-key');
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('rolls configuration back when storing a newly created key fails', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture({ storeRelayKey: vi.fn().mockRejectedValue(new Error('secret failure')) });
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');
    const showError = vi.spyOn(vscode.window, 'showErrorMessage');

    await addConnection(provider);

    expect(config.profiles).toEqual([]);
    expect(config.activeProfile).toBe('');
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith('Personal');
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('secret failure'));
  });

  it('deletes a connection key and selects the remaining connection as default', async () => {
    const config = configurationFixture([
      { name: 'Work', baseUrl: 'https://work.example.test/v1' },
      { name: 'Personal', baseUrl: 'https://personal.example.test/v1' },
    ]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async () => ({ profile: config.profiles[0] } as never));
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete Connection' as never);

    await deleteConnection(provider);

    expect(config.profiles.map((profile) => profile.name)).toEqual(['Personal']);
    expect(config.activeProfile).toBe('Personal');
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith('Work');
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('clears keys for the current profiles after confirmation', async () => {
    const config = configurationFixture([
      { name: 'Work', baseUrl: 'https://work.example.test/v1' },
      { name: 'Personal', baseUrl: 'https://personal.example.test/v1' },
    ]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Clear All Connections' as never);

    await clearAllConnections(provider);

    expect(config.profiles).toEqual([]);
    expect(config.activeProfile).toBe('');
    expect(provider.clearAllRelayKeys).toHaveBeenCalledWith(['Work', 'Personal']);
  });

  it('rejects stale default selections and restores profile updates after active-profile save failures', async () => {
    const config = configurationFixture([{ name: 'Work', baseUrl: 'https://work.example.test/v1' }]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ profile: { name: 'Gone', baseUrl: 'https://gone.example.test/v1' } } as never);
    const showError = vi.spyOn(vscode.window, 'showErrorMessage');
    await setDefaultConnection(provider);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('changed while selecting'));

    config.update.mockImplementation(async (key: string) => {
      if (key === 'activeProfile') throw new Error('active update failed');
    });
    await expect(saveProfiles([{ name: 'Personal', baseUrl: 'https://personal.example.test/v1' }], 'Personal'))
      .rejects.toThrow('active update failed');
    expect(config.update).toHaveBeenLastCalledWith('profiles', config.profiles, vscode.ConfigurationTarget.Global);
  });

  it('renames a connection and moves its profile-scoped key before persisting settings', async () => {
    const config = configurationFixture();
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ profile: config.profiles[0] } as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('{"name":"Company","baseUrl":"https://company.example.test/v1"}');

    await editConnection(provider);

    expect(config.profiles).toEqual([{ name: 'Company', baseUrl: 'https://company.example.test/v1' }]);
    expect(config.activeProfile).toBe('Company');
    expect(provider.moveRelayKey).toHaveBeenCalledWith('Work', 'Company');
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('copies settings without copying API keys', async () => {
    const config = configurationFixture();
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ profile: config.profiles[0] } as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Work copy');

    await copyConnection(provider);

    expect(config.profiles).toEqual([
      { name: 'Work', baseUrl: 'https://work.example.test/v1' },
      { name: 'Work copy', baseUrl: 'https://work.example.test/v1' },
    ]);
    expect(provider.moveRelayKey).not.toHaveBeenCalled();
    expect(provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('does not let a copied connection inherit an orphaned destination key', async () => {
    const config = configurationFixture();
    const provider = providerFixture({ hasRelayKey: vi.fn().mockResolvedValue(true) });
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ profile: config.profiles[0] } as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Work copy');
    const showError = vi.spyOn(vscode.window, 'showErrorMessage');

    await copyConnection(provider);

    expect(config.profiles).toEqual([{ name: 'Work', baseUrl: 'https://work.example.test/v1' }]);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('already has a stored API key'));
    expect(provider.refreshModels).not.toHaveBeenCalled();
  });

  it('shows connection test diagnostics and safely presents structured failures', async () => {
    configurationFixture();
    const provider = providerFixture();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(async (items: readonly { profile: unknown }[]) => items[0] as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    await testConnection(provider);
    expect(pick).toHaveBeenCalledOnce();
    expect(provider.testConnection).toHaveBeenCalledWith('Work', 'https://work.example.test/v1', undefined);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('connection succeeded'), expect.objectContaining({ detail: expect.stringContaining('Models: HTTP 200') }));

    provider.testConnection.mockRejectedValueOnce(new Error('offline'));
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    await testConnection(provider);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Connection failed.'), expect.objectContaining({ detail: 'Category: unknown' }));
  });

  it('creates a connection when setting an API key without an active connection', async () => {
    const config = configurationFixture([]);
    const provider = providerFixture();
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Personal')
      .mockResolvedValueOnce('https://personal.example.test/v1');

    await configureActiveRelay(provider);

    expect(config.activeProfile).toBe('Personal');
    expect(provider.storeRelayKey).toHaveBeenCalledWith('Personal', 'new-key');
  });

  it('saves and clears an active connection key with an invalidating refresh', async () => {
    configurationFixture();
    const provider = providerFixture();
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await configureActiveRelay(provider);
    expect(provider.storeRelayKey).toHaveBeenCalledWith('Work', 'new-key');
    expect(provider.refreshModels).toHaveBeenCalledWith('invalidate');

    await clearActiveRelayKey(provider);
    expect(provider.clearRelayKeyForProfile).toHaveBeenCalledWith('Work');
    expect(provider.refreshModels).toHaveBeenLastCalledWith('invalidate');
    expect(info).toHaveBeenCalledWith('WeaveNet API key for “Work” cleared.');

    configurationFixture([]);
    await clearActiveRelayKey(provider);
    expect(info).toHaveBeenCalledWith('WeaveNet has no active Relay connection API key to clear.');
  });
});