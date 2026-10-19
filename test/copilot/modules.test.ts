import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import type { ConnectionProfile } from '../../src/config/config';
import type { RoutedModel } from '../../src/relay/types';
import {
  CATALOG_ARTIFACT_PEPPER_SECRET,
  RELAY_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
} from '../../src/constants';
import { ModelBindingRegistry, namespacedPickerId } from '../../src/copilot/modelBindingRegistry';
import type { ConnectionRuntime } from '../../src/copilot/connectionRuntimeManager';
import {
  catalogRevision,
  ConnectionRuntimeManager,
  isCancellationError,
  isWeaveNetSecretKey,
} from '../../src/copilot/connectionRuntimeManager';
import { ModelCatalogService } from '../../src/copilot/modelCatalogService';
import { assembleModelCatalog } from '../../src/copilot/modelRegistry';
import { catalogArtifactRevision } from '../../src/copilot/catalogIdentity';
import { ModelSnapshotStore } from '../../src/copilot/modelSnapshotStore';
import type { ModelSnapshotRecord } from '../../src/copilot/modelSnapshotStore';
import { currentProfileFingerprint, diagnosticsOptions } from '../../src/copilot/connectionDiagnosticsStore';
import { InMemoryMemento } from '../support/memento';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const CATALOG_REVISION = 'a'.repeat(64);
const WORK_PROFILE: ConnectionProfile = {
  id: WORK_ID,
  name: 'work',
  baseUrl: 'https://work.example.test/v1',
  includeModels: ['^gpt-'],
  models: [{ id: 'gpt-fixed',
apiType: 'chat-completions' as const }],
};

function routedModel(overrides: Partial<RoutedModel> = {}): RoutedModel {
  return { id: 'gpt-test',
pickerId: 'gpt-test',
upstreamId: 'gpt-test',
catalogSource: 'discovery',
...overrides,
apiType: 'chat-completions' as const };
}

function runtime(overrides: Partial<ConnectionRuntime> = {}): ConnectionRuntime {
  return {
    profile: WORK_PROFILE,
    revision: 'revision-1',
    models: [routedModel()],
    directory: [],
    generation: 0,
    resolved: true,
    phase: 'ready',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('modelBindingRegistry', () => {
  it('namespaces picker ids with the profile id', () => {
    expect(namespacedPickerId(WORK_ID, 'gpt-test')).toBe(`weavenet::${WORK_ID}::gpt-test`);
    expect(namespacedPickerId(WORK_ID, 'a/b c')).toBe(`weavenet::${WORK_ID}::a%2Fb%20c`);
  });

  it('rebuilds bindings from runtimes and exposes them by namespaced id', () => {
    const registry = new ModelBindingRegistry();
    registry.rebuild([runtime(), runtime({
      profile: { ...WORK_PROFILE, id: '22222222-2222-4222-8222-222222222222', name: 'personal' },
      models: [routedModel({ pickerId: 'gpt-personal' })],
    })]);
    expect(registry.all()).toHaveLength(2);
    expect(registry.get(`weavenet::${WORK_ID}::gpt-test`)).toMatchObject({ profileId: WORK_ID, revision: 'revision-1' });
    expect(registry.get('gpt-test')).toBeUndefined();
  });

  it('clears stale bindings on rebuild', () => {
    const registry = new ModelBindingRegistry();
    registry.rebuild([runtime()]);
    expect(registry.all()).toHaveLength(1);
    registry.rebuild([]);
    expect(registry.all()).toHaveLength(0);
  });
});

describe('modelCatalogService', () => {
  const debug = vi.fn();
  it('persists a single directory and assembles fixed models during restoration', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never);
    const service = new ModelCatalogService(new ModelSnapshotStore(new InMemoryMemento()), debug);
    expect(service.restore(WORK_ID, CATALOG_REVISION)).toBeUndefined();
    await service.persistSnapshot(WORK_ID, CATALOG_REVISION, [routedModel()]);
    const record = service.restore(WORK_ID, CATALOG_REVISION)!;
    expect(record.directory).toHaveLength(1);
    const config = getConfig(WORK_PROFILE);
    expect(service.assemble(config, record.directory).map(model => model.id)).toEqual(['gpt-fixed', 'gpt-test']);
  });
  it('keeps persistence failures out of refresh and deletion', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never);
    const memento = new InMemoryMemento(); memento.failUpdates = true;
    const service = new ModelCatalogService(new ModelSnapshotStore(memento), debug);
    await expect(service.persistSnapshot(WORK_ID, CATALOG_REVISION, [])).resolves.toBeUndefined();
    await expect(service.clearSnapshot(WORK_PROFILE)).resolves.toBeUndefined();
    await expect(service.deleteProfile(WORK_ID)).resolves.toBeUndefined();
    await expect(service.clearAll()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });
});

describe('connectionRuntimeManager helpers', () => {
  it('rebuilds bindings before status and picker notifications', () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
      inspect: <T>(key: string) => key === 'profiles'
        ? { globalValue: [WORK_PROFILE] as T }
        : undefined,
    } as never);
    const order: string[] = [];
    const manager = new ConnectionRuntimeManager({
      auth: { getApiKey: vi.fn() } as never,
      diagnosticsStore: { get: vi.fn() } as never,
      catalog: {
        restore: vi.fn(),
        deleteProfile: vi.fn().mockResolvedValue(undefined),
      } as never,
      debug: vi.fn(),
      rebuildBindings: () => order.push('bindings'),
      onStatusChanged: () => order.push('status'),
      onCatalogChanged: () => order.push('catalog'),
    });

    manager.syncProfiles();

    expect(order).toEqual(['bindings', 'status', 'catalog']);
  });

  it('publishes a restored catalog before refresh completes and settles cancellation as degraded', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
      inspect: <T>(key: string) => key === 'profiles'
        ? { globalValue: [WORK_PROFILE] as T }
        : undefined,
    } as never);
    const restoredModel = routedModel({
      id: 'gpt-restored',
      pickerId: 'gpt-restored',
      upstreamId: 'gpt-restored',
    });
    const restore = vi.fn((_profileId: string, catalogRevision: string): ModelSnapshotRecord => ({
      schemaVersion: 3,
      profileId: WORK_ID,
      catalogRevision,
      savedAt: Date.now(),
      directory: [restoredModel],
    }));
    let rejectLoad!: (reason?: unknown) => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => { markLoadStarted = resolve; });
    const pendingLoad = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    const load = vi.fn(() => {
      markLoadStarted();
      return pendingLoad;
    });
    const publishedModelCounts: number[] = [];
    const manager = new ConnectionRuntimeManager({
      auth: {
        getApiKey: vi.fn().mockResolvedValue('key'),
        getCatalogArtifactPepper: vi.fn().mockResolvedValue('p'.repeat(43)),
      } as never,
      diagnosticsStore: { get: vi.fn() } as never,
      catalog: {
        restore,
        assemble: (_config: unknown, directory: RoutedModel[]) => directory,
        load,
      } as never,
      debug: vi.fn(),
      rebuildBindings: () => {
        publishedModelCounts.push(manager.getRuntimes()
          .reduce((count, runtime) => count + runtime.models.length, 0));
      },
      onStatusChanged: vi.fn(),
      onCatalogChanged: vi.fn(),
    });
    let refreshSettled = false;

    const refresh = manager.refreshAll(false).finally(() => { refreshSettled = true; });
    await loadStarted;

    expect(refreshSettled).toBe(false);
    expect(restore).toHaveBeenCalledWith(WORK_ID, expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(manager.getRuntime(WORK_ID)?.models).toEqual([restoredModel]);
    expect(publishedModelCounts).toContain(1);

    rejectLoad(new vscode.CancellationError());
    await expect(refresh).resolves.toBeUndefined();

    expect(manager.getRuntime(WORK_ID)).toMatchObject({
      phase: 'degraded',
      resolved: false,
      models: [restoredModel],
    });
  });

  it('restores local catalogs without the network and refreshes them in the background', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
      inspect: <T>(key: string) => key === 'profiles'
        ? { globalValue: [WORK_PROFILE] as T }
        : undefined,
    } as never);
    const restoredModel = routedModel({ id: 'gpt-restored', pickerId: 'gpt-restored', upstreamId: 'gpt-restored' });
    const liveModel = routedModel({ id: 'gpt-live', pickerId: 'gpt-live', upstreamId: 'gpt-live' });
    const load = vi.fn().mockResolvedValue({ models: [liveModel], directory: [liveModel] });
    const manager = new ConnectionRuntimeManager({
      auth: {
        getApiKey: vi.fn().mockResolvedValue('key'),
        getCatalogArtifactPepper: vi.fn().mockResolvedValue('p'.repeat(43)),
      } as never,
      diagnosticsStore: { get: vi.fn() } as never,
      catalog: {
        restore: vi.fn((): ModelSnapshotRecord => ({
          schemaVersion: 3,
          profileId: WORK_ID,
          catalogRevision: CATALOG_REVISION,
          savedAt: Date.now(),
          directory: [restoredModel],
        })),
        assemble: (_config: unknown, directory: RoutedModel[]) => directory,
        load,
        persistSnapshot: vi.fn().mockResolvedValue(undefined),
      } as never,
      debug: vi.fn(),
      rebuildBindings: vi.fn(),
      onStatusChanged: vi.fn(),
      onCatalogChanged: vi.fn(),
    });

    await expect(manager.restoreLocalCatalogs()).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(manager.getRuntime(WORK_ID)?.models).toEqual([restoredModel]);

    manager.startBackgroundRefresh();
    await manager.getRuntime(WORK_ID)?.refreshTask;

    expect(load).toHaveBeenCalledTimes(1);
    expect(manager.getRuntime(WORK_ID)).toMatchObject({ models: [liveModel], resolved: true, phase: 'ready' });
  });

  it.each([
    { configurationChanged: false, completedRefresh: true },
    { configurationChanged: true, completedRefresh: true },
    { configurationChanged: true, completedRefresh: false },
  ])('ignores stale local restoration (configuration changed=$configurationChanged, refreshed=$completedRefresh)', async ({ configurationChanged, completedRefresh }) => {
    let profiles = [WORK_PROFILE];
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (key: string) => key === 'modelMetadataEnabled' ? false : undefined,
      inspect: (key: string) => key === 'profiles' ? { globalValue: profiles } : undefined,
    } as never);
    const pepper = 'p'.repeat(43);
    const oldRevision = catalogArtifactRevision(getConfig(WORK_PROFILE), 'old-key', pepper);
    const oldModel = routedModel({ id: 'gpt-old', pickerId: 'gpt-old', upstreamId: 'gpt-old' });
    const liveModel = routedModel({ id: 'gpt-live', pickerId: 'gpt-live', upstreamId: 'gpt-live' });
    let releaseKey!: (value: string) => void;
    const getApiKey = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { releaseKey = resolve; }))
      .mockResolvedValue('new-key');
    let snapshotDeleted = false;
    const load = vi.fn(async (config: ReturnType<typeof getConfig>) => ({
      directory: [liveModel], models: assembleModelCatalog(config, [liveModel]),
    }));
    const onCatalogChanged = vi.fn();
    const manager = new ConnectionRuntimeManager({
      auth: { getApiKey, getCatalogArtifactPepper: async () => pepper } as never,
      diagnosticsStore: { get: vi.fn() } as never,
      catalog: {
        restore: (_profileId: string, revision: string) => !snapshotDeleted && revision === oldRevision
          ? { schemaVersion: 3, profileId: WORK_ID, catalogRevision: revision, savedAt: Date.now(), directory: [oldModel] }
          : undefined,
        assemble: assembleModelCatalog, load,
        deleteProfile: async () => { snapshotDeleted = true; },
        persistSnapshot: async () => undefined,
      } as never,
      debug: vi.fn(), rebuildBindings: vi.fn(), onStatusChanged: vi.fn(), onCatalogChanged,
    });
    const restore = manager.restoreLocalCatalogs();
    await vi.waitFor(() => expect(releaseKey).toBeDefined());
    if (configurationChanged) profiles = [{ ...WORK_PROFILE, models: [{ id: 'gpt-new-fixed', apiType: 'chat-completions' }] }];
    if (completedRefresh) await manager.refreshAll(false);
    else manager.syncProfiles();
    const completed = { ...manager.getRuntime(WORK_ID)! };
    onCatalogChanged.mockClear();

    releaseKey('old-key');
    await restore;
    if (completedRefresh) await manager.refreshAll(false);

    expect(manager.getRuntime(WORK_ID)).toEqual(completed);
    expect(manager.getRuntime(WORK_ID)?.models.map(model => model.id)).toEqual(!completedRefresh ? []
      : configurationChanged ? ['gpt-live', 'gpt-new-fixed'] : ['gpt-fixed', 'gpt-live']);
    expect(load).toHaveBeenCalledTimes(completedRefresh ? 1 : 0);
    expect(onCatalogChanged).not.toHaveBeenCalled();
  });

  it('reports a connection without a persisted catalog instead of faking an empty one', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
      inspect: <T>(key: string) => key === 'profiles'
        ? { globalValue: [WORK_PROFILE] as T }
        : undefined,
    } as never);
    const load = vi.fn();
    const manager = new ConnectionRuntimeManager({
      auth: {
        getApiKey: vi.fn().mockResolvedValue('key'),
        getCatalogArtifactPepper: vi.fn().mockResolvedValue('p'.repeat(43)),
      } as never,
      diagnosticsStore: { get: vi.fn() } as never,
      catalog: {
        restore: vi.fn(() => undefined),
        assemble: vi.fn(() => []),
        load,
      } as never,
      debug: vi.fn(),
      rebuildBindings: vi.fn(),
      onStatusChanged: vi.fn(),
      onCatalogChanged: vi.fn(),
    });

    await expect(manager.restoreLocalCatalogs()).resolves.toEqual([WORK_ID]);
    expect(load).not.toHaveBeenCalled();
    expect(manager.getRuntime(WORK_ID)).toMatchObject({ models: [], resolved: false });
  });

  it.each(['ready', 'degraded', 'refreshing'] as const)('updates metadata without changing %s connection health or its refresh task', (phase) => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: () => undefined,
      inspect: (key: string) => key === 'profiles' ? { globalValue: [WORK_PROFILE] } : undefined,
    } as never);
    const assemble = vi.fn((_config: unknown, directory: readonly RoutedModel[]) => directory.map(model => ({ ...model, imageInput: true })));
    const getApiKey = vi.fn();
    const load = vi.fn();
    const persistSnapshot = vi.fn();
    const rebuildBindings = vi.fn();
    const onCatalogChanged = vi.fn();
    const onStatusChanged = vi.fn();
    const manager = new ConnectionRuntimeManager({
      auth: { getApiKey } as never, diagnosticsStore: { get: vi.fn() } as never,
      catalog: { assemble, load, persistSnapshot } as never, debug: vi.fn(),
      rebuildBindings, onCatalogChanged, onStatusChanged,
    });
    const current = manager.syncProfiles()[0];
    Object.assign(current, { artifactRevision: CATALOG_REVISION, directory: [routedModel()], models: [routedModel()],
      phase, resolved: phase !== 'refreshing', generation: 7, refreshedAt: 123, message: 'existing status',
      refreshTask: new Promise<void>(() => undefined) });
    const before = { ...current };
    vi.clearAllMocks();

    manager.refreshModelMetadata();

    expect(current.models).toEqual([expect.objectContaining({ imageInput: true })]);
    expect({ ...current, models: before.models }).toEqual(before);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(persistSnapshot).not.toHaveBeenCalled();
    expect(onStatusChanged).not.toHaveBeenCalled();
    expect(rebuildBindings).toHaveBeenCalledOnce();
    expect(onCatalogChanged).toHaveBeenCalledOnce();
  });

  it('does not assemble unverified catalogs or connections with metadata disabled', () => {
    const values: Record<string, unknown> = {};
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (key: string) => values[key],
      inspect: (key: string) => key === 'profiles' ? { globalValue: [WORK_PROFILE] } : undefined,
    } as never);
    const assemble = vi.fn();
    const onCatalogChanged = vi.fn();
    const manager = new ConnectionRuntimeManager({
      auth: {} as never, diagnosticsStore: { get: vi.fn() } as never,
      catalog: { assemble } as never, debug: vi.fn(), rebuildBindings: vi.fn(), onCatalogChanged, onStatusChanged: vi.fn(),
    });
    const current = manager.syncProfiles()[0];
    onCatalogChanged.mockClear();

    manager.refreshModelMetadata();
    current.artifactRevision = CATALOG_REVISION;
    values.modelMetadataEnabled = false;
    manager.refreshModelMetadata();

    expect(assemble).not.toHaveBeenCalled();
    expect(onCatalogChanged).not.toHaveBeenCalled();
    expect(current.models).toEqual([]);
  });

  it('computes a stable catalog revision from profile settings', () => {
    const values: Record<string, unknown> = {};
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => values[key] as T | undefined,
    } as never);
    const profile = {
      ...WORK_PROFILE,
      requestHeaders: { 'X-Tenant': 'team-a', 'X-Region': 'west' },
    };
    const first = catalogRevision(profile);
    const second = catalogRevision(profile);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).toBe(second);
    expect(catalogRevision({
      ...profile,
      requestHeaders: { 'x-region': 'west', 'x-tenant': 'team-a' },
    })).toBe(first);
    expect(catalogRevision({
      ...profile,
      requestHeaders: { 'X-Tenant': 'team-b', 'X-Region': 'west' },
    })).not.toBe(first);
    expect(catalogRevision({ ...profile, baseUrl: 'https://other.example.test/v1' })).not.toBe(first);

    expect(catalogRevision({ ...profile, apiType: 'responses' })).not.toBe(first);
    values.openaiApiStrategy = 'responses';
    expect(catalogRevision(profile)).toBe(first);
    values.modelMetadataEnabled = false;
    expect(catalogRevision(profile)).not.toBe(first);
  });

  it('detects cancellation errors by instance and by name', () => {
    expect(isCancellationError(new vscode.CancellationError())).toBe(true);
    expect(isCancellationError(new Error('cancelled'))).toBe(false);
    const named = new Error('nope');
    named.name = 'CancellationError';
    expect(isCancellationError(named)).toBe(true);
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(isCancellationError(aborted)).toBe(true);
    expect(isCancellationError('plain string')).toBe(false);
  });

  it('recognizes WeaveNet secret keys', () => {
    expect(isWeaveNetSecretKey(RELAY_API_KEY_SECRET)).toBe(true);
    expect(isWeaveNetSecretKey(`${RELAY_API_KEY_SECRET}.profileId.${WORK_ID}`)).toBe(true);
    expect(isWeaveNetSecretKey(`${RELAY_API_KEY_SECRET}.profile.work`)).toBe(true);
    expect(isWeaveNetSecretKey(LEGACY_API_KEY_SECRET)).toBe(true);
    expect(isWeaveNetSecretKey(OPENAI_API_KEY_SECRET)).toBe(true);
    expect(isWeaveNetSecretKey(CHATGPT_API_KEY_SECRET)).toBe(true);
    expect(isWeaveNetSecretKey(CLAUDE_API_KEY_SECRET)).toBe(true);
    expect(isWeaveNetSecretKey(CATALOG_ARTIFACT_PEPPER_SECRET)).toBe(false);
    expect(isWeaveNetSecretKey('weavenet.somethingElse')).toBe(false);
  });
});

describe('connectionDiagnosticsStore helpers', () => {
  it('returns configured anthropic version in diagnostics options', () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => key === 'anthropicVersion' ? '2024-10-22' as T : undefined as T,
    } as never);
    expect(diagnosticsOptions()).toEqual({ anthropicVersion: '2024-10-22' });
  });

  it('resolves fingerprints for known profiles and returns undefined otherwise', () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
      inspect: <T>(_key: string) => ({ globalValue: [WORK_PROFILE] as T }),
    } as never);
    expect(currentProfileFingerprint(WORK_ID)).toBeTruthy();
    expect(currentProfileFingerprint('22222222-2222-4222-8222-222222222222')).toBeUndefined();
  });
});
