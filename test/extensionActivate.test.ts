import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import type { ConnectionProfile } from '../src/config/config';

/**
 * Activation wiring is the only place that registers the provider, the commands,
 * the status bar and the secret migration, so it is covered here with every
 * side-effecting collaborator mocked. The provider implementation itself is
 * covered by its own tests.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const WORK_PROFILE: ConnectionProfile = {
  id: WORK_ID,
  name: 'Work',
  baseUrl: 'https://work.example.test/v1',
  apiType: 'chat-completions',
};

const mocks = vi.hoisted(() => {
  const provider = {
    migrateRelayKeys: vi.fn(async () => undefined),
    logMetadata: vi.fn(),
    refreshModels: vi.fn(async () => undefined),
  };
  return {
    provider,
    providerCtor: vi.fn(function providerCtor() { return provider; }),
    resetLegacyInstallation: vi.fn(),
    migrateProfilePoolConfiguration: vi.fn(),
    initMetadataCache: vi.fn(),
    onMetadataChanged: vi.fn(() => ({ dispose: () => undefined })),
    registerConnectionCommands: vi.fn(() => ({ dispose: () => undefined })),
    showInitialConnectionPrompt: vi.fn(),
    showLegacyResetPrompt: vi.fn(),
    createStatusBarItem: vi.fn(() => ({ dispose: () => undefined })),
    registerProvider: vi.fn(() => ({ dispose: () => undefined })),
    order: [] as string[],
  };
});

vi.mock('../src/copilot/provider', () => ({ WeaveNetChatProvider: mocks.providerCtor }));
vi.mock('../src/migration/legacyReset', () => ({ resetLegacyInstallation: mocks.resetLegacyInstallation }));
vi.mock('../src/migration/profilePool', () => ({ migrateProfilePoolConfiguration: mocks.migrateProfilePoolConfiguration }));
vi.mock('../src/metadata/metadataCache', () => ({
  initMetadataCache: mocks.initMetadataCache,
  onMetadataChanged: mocks.onMetadataChanged,
}));
vi.mock('../src/commands/connectionCommands', () => ({
  registerConnectionCommands: mocks.registerConnectionCommands,
  showInitialConnectionPrompt: mocks.showInitialConnectionPrompt,
  showLegacyResetPrompt: mocks.showLegacyResetPrompt,
}));
vi.mock('../src/ui/statusBarPresenter', () => ({ createStatusBarItem: mocks.createStatusBarItem }));

function contextFixture(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function configurationFixture(profiles: ConnectionProfile[]): void {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: () => undefined,
    inspect: (key: string) => key === 'profiles' ? { globalValue: profiles } : undefined,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.resetLegacyInstallation.mockImplementation(async () => {
    mocks.order.push('legacyReset');
    return { cleaned: false, removedBaseUrl: false, removedSecretCount: 0 };
  });
  mocks.migrateProfilePoolConfiguration.mockImplementation(async () => { mocks.order.push('profilePool'); });
  mocks.providerCtor.mockImplementation(function providerCtor() { mocks.order.push('provider'); return mocks.provider; });
  mocks.provider.migrateRelayKeys.mockImplementation(async () => { mocks.order.push('keys'); });
  mocks.provider.refreshModels.mockImplementation(async () => { mocks.order.push('refresh'); });
  mocks.registerConnectionCommands.mockImplementation(() => { mocks.order.push('commands'); return { dispose: () => undefined }; });
  mocks.createStatusBarItem.mockImplementation(() => { mocks.order.push('statusBar'); return { dispose: () => undefined }; });
  mocks.registerProvider.mockImplementation(() => { mocks.order.push('registerProvider'); return { dispose: () => undefined }; });
});

afterEach(() => vi.restoreAllMocks());

describe('extension activation', () => {
  it('migrates state before publishing the provider and wires every disposable', async () => {
    configurationFixture([WORK_PROFILE]);
    const register = vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation(() => mocks.registerProvider() as never);
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined);
    const context = contextFixture();

    await activate(context);

    expect(mocks.order).toEqual(['legacyReset', 'profilePool', 'provider', 'keys', 'statusBar', 'commands', 'registerProvider', 'refresh']);
    expect(mocks.provider.migrateRelayKeys).toHaveBeenCalledWith([WORK_PROFILE]);
    expect(register).toHaveBeenCalledWith('weavenet', mocks.provider);
    expect(context.subscriptions).toHaveLength(4);
    expect(mocks.initMetadataCache).toHaveBeenCalledWith(context, expect.any(Function));
    expect(mocks.showInitialConnectionPrompt).toHaveBeenCalledWith(context);
    expect(mocks.showLegacyResetPrompt).not.toHaveBeenCalled();
    expect(mocks.provider.refreshModels).toHaveBeenCalledOnce();
  });

  it('prompts about removed legacy data instead of the first-run prompt', async () => {
    configurationFixture([]);
    vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation(() => mocks.registerProvider() as never);
    mocks.resetLegacyInstallation.mockResolvedValue({ cleaned: true, removedBaseUrl: true, removedSecretCount: 2 });

    await activate(contextFixture());

    expect(mocks.showLegacyResetPrompt).toHaveBeenCalledOnce();
    expect(mocks.showInitialConnectionPrompt).not.toHaveBeenCalled();
  });

  it('reports a failed key migration without stopping activation', async () => {
    configurationFixture([WORK_PROFILE]);
    vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation(() => mocks.registerProvider() as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    mocks.provider.migrateRelayKeys.mockRejectedValueOnce(new Error('secret storage unavailable'));
    const context = contextFixture();

    await activate(context);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not migrate Relay API keys'));
    expect(context.subscriptions).toHaveLength(4);
  });

  it('stops before creating a provider when configuration migration fails', async () => {
    configurationFixture([WORK_PROFILE]);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const register = vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation(() => mocks.registerProvider() as never);
    mocks.migrateProfilePoolConfiguration.mockRejectedValueOnce(new Error('invalid settings'));
    const context = contextFixture();

    await activate(context);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not migrate Relay connections'));
    expect(mocks.providerCtor).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(context.subscriptions).toHaveLength(0);
    expect(mocks.showInitialConnectionPrompt).not.toHaveBeenCalled();
  });

  it('continues activation when legacy cleanup fails and logs a failed Copilot activation', async () => {
    configurationFixture([]);
    vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation(() => mocks.registerProvider() as never);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    mocks.resetLegacyInstallation.mockRejectedValueOnce(new Error('settings locked'));
    const activateChat = vi.fn(async () => { throw new Error('copilot chat failed'); });
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue({ activate: activateChat } as never);

    await activate(contextFixture());
    await vi.waitFor(() => expect(mocks.provider.logMetadata).toHaveBeenCalled());

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not clear settings from the previous connection format'));
    expect(activateChat).toHaveBeenCalledOnce();
    expect(mocks.provider.logMetadata).toHaveBeenCalledWith(expect.stringContaining('copilot chat failed'));
  });
});
