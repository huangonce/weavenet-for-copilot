import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { migrateProfilePoolConfiguration } from '../../src/migration/profilePool';
import { getConfig } from '../../src/config/config';
import { catalogArtifactRevision } from '../../src/copilot/catalogIdentity';
import { ModelSnapshotStore } from '../../src/copilot/modelSnapshotStore';
import { CATALOG_ARTIFACT_PEPPER_SECRET, RELAY_API_KEY_SECRET } from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

const ID = '11111111-1111-4111-8111-111111111111';
const PEPPER = 'p'.repeat(43);
const PROFILE = { id: ID, name: 'Work', baseUrl: 'https://work.example.test/v1' };
const SECRET = `${RELAY_API_KEY_SECRET}.profileId.${ID}`;

function fixture(initial: Record<string, unknown>, apiKey: string | undefined = 'key') {
  const settings = new Map(Object.entries(initial));
  const update = vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) settings.delete(key); else settings.set(key, value);
  });
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: <T>(key: string) => settings.get(key) as T | undefined,
    inspect: <T>(key: string) => ({ globalValue: settings.get(key) as T | undefined }), update,
  } as never);
  const values = new Map<string, string>([[CATALOG_ARTIFACT_PEPPER_SECRET, PEPPER]]);
  if (apiKey) values.set(SECRET, apiKey);
  const secrets = {
    get: vi.fn(async (key: string) => values.get(key)),
    store: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
  const state = new InMemoryMemento();
  return { settings, update, secrets, values, state,
    context: { secrets, globalState: state, subscriptions: [] } as unknown as vscode.ExtensionContext };
}

function seedSnapshot(state: InMemoryMemento, strategy = 'auto', fixed = false, apiKey = 'key') {
  // Serialized fixture of the 0.7.x credential identity, independent of the new identity implementation.
  const identity = JSON.stringify({ baseUrl: PROFILE.baseUrl, excludeModels: [], includeModels: [],
    models: fixed ? [{ id: 'gpt-x', route: 'openai', toolCalling: true }] : [],
    openaiApiStrategy: strategy, profileId: ID, requestHeaders: [] });
  const revision = createHmac('sha256', PEPPER).update('credential\0').update(apiKey).update('\0catalog\0').update(identity).digest('hex');
  const models = [{ id: 'gpt-x', upstreamId: 'gpt-x', pickerId: 'gpt-x', protocol: 'openai', route: 'openai',
    catalogSource: 'discovery', openaiApi: strategy === 'auto' ? 'responses' : 'chat', toolCalling: true, maxInputTokens: 100_000 }];
  const key = `weavenet-copilot.modelSnapshots.v2.${ID}.${revision}`;
  state.values.set(key, { schemaVersion: 2, profileId: ID, catalogRevision: revision, savedAt: Date.now(),
    models, snapshots: { openai: models, claude: [], chatgpt: [] } });
  return key;
}

afterEach(() => vi.restoreAllMocks());

describe('explicit protocol upgrade safety', () => {
  it('reads an uncached old directory once, preserves native Claude and keeps UUID secrets', async () => {
    const f = fixture({ profiles: [PROFILE] });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'claude-private', capabilities: { tool_calling: true } }, { id: 'company-gpt' },
    ] }), { headers: { 'content-type': 'application/json' } }));
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(result.profiles[0]).toMatchObject({ id: ID, apiType: 'chat-completions', models: [{ id: 'claude-private', apiType: 'messages' }] });
    expect(fetch.mock.calls.every(([url, init]) => String(url).endsWith('/models') && !init?.method)).toBe(true);
    expect(f.values.get(SECRET)).toBe('key');
    expect(f.secrets.delete).not.toHaveBeenCalled();
    expect(f.secrets.store).not.toHaveBeenCalled();
    const revision = catalogArtifactRevision(getConfig(result.profiles[0]), 'key', PEPPER);
    const snapshot = new ModelSnapshotStore(f.state).get(ID, revision);
    expect(snapshot?.directory.find((model) => model.id === 'claude-private')).toMatchObject({ apiType: 'messages', toolCalling: true });
    await migrateProfilePoolConfiguration(f.context);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains a fixed model’s cached auto Responses protocol and offline catalog', async () => {
    const f = fixture({ profiles: [{ ...PROFILE, models: [{ id: 'gpt-x', route: 'openai', toolCalling: true }] }], openaiApiStrategy: 'auto' });
    const oldKey = seedSnapshot(f.state, 'auto', true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(result.profiles[0].models).toEqual([expect.objectContaining({ id: 'gpt-x', apiType: 'responses', toolCalling: true })]);
    const revision = catalogArtifactRevision(getConfig(result.profiles[0]), 'key', PEPPER);
    expect(new ModelSnapshotStore(f.state).get(ID, revision)?.directory[0]).toMatchObject({ apiType: 'responses', maxInputTokens: 100_000 });
    expect(f.state.values.has(oldKey)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches a published v2 identity after legacy model, pattern, and header normalization', async () => {
    const f = fixture({ profiles: [{ ...PROFILE, includeModels: ['  ^gpt-  ', '^gpt-', '['], requestHeaders: {
      ' X-Tenant ': ' team-a ', 'X-Ignored': 7, Authorization: 'ignored',
    }, models: [
      { id: '  gpt-x  ', route: 'openai', name: '  Custom  ', contextWindows: [400_000, 200_000, 400_000, 0, -1, '8192'],
        maxInputTokens: 100_000, maxOutputTokens: 0, toolCalling: true, imageInput: 'true', thinking: false,
        openai: { contextWindow: true, promptCacheKey: false, reasoningEfforts: ['high', 'low', 'high', 'invalid'],
          defaultReasoningEffort: 'max', sampling: true, samplingEfforts: ['high'], imageCompatibility: 'standard' } },
      { id: 'ignored', route: 'invalid' },
    ] }], openaiApiStrategy: 'auto' });
    // Exact serialized identity produced by the published normalizers, independent of migration helpers.
    const identity = JSON.stringify({ baseUrl: PROFILE.baseUrl, excludeModels: [], includeModels: ['^gpt-'], models: [{
      contextWindows: [200_000, 400_000], id: 'gpt-x', maxInputTokens: 100_000, name: 'Custom',
      openai: { contextWindow: true, promptCacheKey: false, reasoningEfforts: ['high', 'low'] },
      route: 'openai', thinking: false, toolCalling: true,
    }], openaiApiStrategy: 'auto', profileId: ID, requestHeaders: [['x-tenant', 'team-a']] });
    const revision = createHmac('sha256', PEPPER).update('credential\0').update('key').update('\0catalog\0').update(identity).digest('hex');
    const models = [{ id: 'gpt-x', upstreamId: 'gpt-x', pickerId: 'gpt-x', protocol: 'openai', route: 'openai', openaiApi: 'responses' }];
    const key = `weavenet-copilot.modelSnapshots.v2.${ID}.${revision}`;
    f.state.values.set(key, { schemaVersion: 2, profileId: ID, catalogRevision: revision, savedAt: Date.now(), models,
      snapshots: { openai: models, chatgpt: [], claude: [] } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.profiles[0].models?.find(model => model.id === 'gpt-x')).toMatchObject({ apiType: 'responses', name: 'Custom', toolCalling: true });
    const nextRevision = catalogArtifactRevision(getConfig(result.profiles[0]), 'key', PEPPER);
    expect(new ModelSnapshotStore(f.state).get(ID, nextRevision)?.directory[0].apiType).toBe('responses');
    expect(f.state.values.has(key)).toBe(true);
  });

  it('retains an ordinary private Chat catalog across offline upgrades', async () => {
    const f = fixture({ profiles: [PROFILE] });
    seedSnapshot(f.state, 'chat');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await migrateProfilePoolConfiguration(f.context);
    const revision = catalogArtifactRevision(getConfig(result.profiles[0]), 'key', PEPPER);
    expect(new ModelSnapshotStore(f.state).get(ID, revision)?.directory).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not trust another credential’s snapshot and instead reads the current directory', async () => {
    const f = fixture({ profiles: [PROFILE], openaiApiStrategy: 'auto' }, 'new-key');
    seedSnapshot(f.state, 'auto', false, 'old-key');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'current' }] })));
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(result.profiles[0].models).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer new-key');
  });

  it('leaves ordinary settings and secrets intact when an uncached directory is unreachable', async () => {
    const f = fixture({ profiles: [PROFILE], openaiApiStrategy: 'auto' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(migrateProfilePoolConfiguration(f.context)).rejects.toThrow('offline');
    expect(f.settings.get('profiles')).toEqual([PROFILE]);
    expect(f.settings.get('openaiApiStrategy')).toBe('auto');
    expect(f.update).not.toHaveBeenCalled();
    expect(f.values.get(SECRET)).toBe('key');
  });

  it('rolls settings back if preserving the validated directory fails', async () => {
    const f = fixture({ profiles: [PROFILE] });
    seedSnapshot(f.state, 'chat');
    f.state.failUpdates = true;
    await expect(migrateProfilePoolConfiguration(f.context)).rejects.toThrow('Memento update failed');
    expect(f.settings.get('profiles')).toEqual([PROFILE]);
    expect(f.values.get(SECRET)).toBe('key');
  });

  it('keeps an old global Chat veto while migrating fixed Responses declarations', async () => {
    const f = fixture({ profiles: [{ ...PROFILE, models: [
      { id: 'model', route: 'openai', openaiApi: 'responses' }, { id: 'native', route: 'claude' },
    ] }], openaiApiStrategy: 'chat' }, '');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(result.profiles[0].models).toEqual([
      expect.objectContaining({ id: 'model', apiType: 'chat-completions' }),
      expect.objectContaining({ id: 'native', apiType: 'messages' }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not overwrite connections edited while an old directory is being read', async () => {
    const f = fixture({ profiles: [PROFILE] });
    const edited = [{ ...PROFILE, name: 'New name', apiType: 'responses' }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      f.settings.set('profiles', edited);
      return new Response(JSON.stringify({ data: [] }));
    });
    await expect(migrateProfilePoolConfiguration(f.context)).rejects.toThrow('Connections changed');
    expect(f.update).not.toHaveBeenCalled();
    expect(f.settings.get('profiles')).toEqual(edited);
  });

  it('defers migration when credentials change during directory discovery', async () => {
    const f = fixture({ profiles: [PROFILE] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      f.values.set(SECRET, 'new-key');
      return new Response(JSON.stringify({ data: [{ id: 'claude-old-account' }] }));
    });
    await expect(migrateProfilePoolConfiguration(f.context)).rejects.toThrow('credentials changed');
    expect(f.update).not.toHaveBeenCalled();
    expect(f.settings.get('profiles')).toEqual([PROFILE]);
  });

  it('preserves both native and Responses variants sharing an upstream ID in offline snapshots', async () => {
    const declarations = [{ id: 'shared', openaiApi: 'responses', route: 'openai' }, { id: 'shared', route: 'claude' }];
    const f = fixture({ profiles: [{ ...PROFILE, models: declarations }], openaiApiStrategy: 'auto' });
    const identity = JSON.stringify({ baseUrl: PROFILE.baseUrl, excludeModels: [], includeModels: [], models: declarations,
      openaiApiStrategy: 'auto', profileId: ID, requestHeaders: [] });
    const revision = createHmac('sha256', PEPPER).update('credential\0').update('key').update('\0catalog\0').update(identity).digest('hex');
    const models = [
      { id: 'shared', upstreamId: 'shared', pickerId: 'shared::openai', protocol: 'openai', route: 'openai', openaiApi: 'responses' },
      { id: 'shared', upstreamId: 'shared', pickerId: 'shared::claude', protocol: 'claude', route: 'claude' },
    ];
    f.state.values.set(`weavenet-copilot.modelSnapshots.v2.${ID}.${revision}`, { schemaVersion: 2, profileId: ID, catalogRevision: revision,
      savedAt: Date.now(), models, snapshots: { openai: models, chatgpt: [], claude: [] } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await migrateProfilePoolConfiguration(f.context);
    const nextRevision = catalogArtifactRevision(getConfig(result.profiles[0]), 'key', PEPPER);
    const restored = new ModelSnapshotStore(f.state).get(ID, nextRevision);
    expect(restored?.directory).toEqual(expect.arrayContaining([
      expect.objectContaining({ apiType: 'responses' }), expect.objectContaining({ apiType: 'messages' }),
    ]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let an unregistered workspace strategy change global connection migration', async () => {
    const f = fixture({ profiles: [PROFILE] });
    seedSnapshot(f.state, 'chat');
    const config = vscode.workspace.getConfiguration('weavenet-copilot');
    vi.spyOn(config, 'get').mockImplementation((key) => key === 'openaiApiStrategy' ? 'responses' as never : f.settings.get(key) as never);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await migrateProfilePoolConfiguration(f.context);
    expect(result.profiles[0].apiType).toBe('chat-completions');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not rewrite or fetch newly configured explicit connections', async () => {
    const f = fixture({ profiles: [{ ...PROFILE, apiType: 'messages' }] });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const first = await migrateProfilePoolConfiguration(f.context);
    expect(first.profiles[0].apiType).toBe('messages');
    expect(fetch).not.toHaveBeenCalled();
  });
});
