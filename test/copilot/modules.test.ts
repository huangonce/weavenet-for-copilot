import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../src/config/config';
import type { RoutedModel } from '../../src/relay/types';
import {
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
import { ModelSnapshotStore } from '../../src/copilot/modelSnapshotStore';
import { currentProfileFingerprint, diagnosticsOptions } from '../../src/copilot/connectionDiagnosticsStore';
import { InMemoryMemento } from '../support/memento';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const WORK_PROFILE: ConnectionProfile = {
  id: WORK_ID,
  name: 'work',
  baseUrl: 'https://work.example.test/v1',
  includeModels: ['^gpt-'],
  models: [{ id: 'gpt-fixed', route: 'openai' }],
};

function routedModel(overrides: Partial<RoutedModel> = {}): RoutedModel {
  return {
    id: 'gpt-test',
    pickerId: 'gpt-test',
    upstreamId: 'gpt-test',
    protocol: 'openai',
    route: 'openai',
    catalogSource: 'discovery',
    ...overrides,
  };
}

function runtime(overrides: Partial<ConnectionRuntime> = {}): ConnectionRuntime {
  return {
    profile: WORK_PROFILE,
    revision: 'revision-1',
    models: [routedModel()],
    snapshots: new Map(),
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

  it('maps non-empty snapshot routes into a map', () => {
    const service = new ModelCatalogService(new ModelSnapshotStore(new InMemoryMemento()), debug);
    const map = service.snapshotMap({
      schemaVersion: 1,
      profileId: WORK_ID,
      savedAt: 1,
      snapshots: { openai: [routedModel()], chatgpt: [], claude: [] },
      models: [routedModel()],
    });
    expect(map.size).toBe(1);
    expect(map.get('openai')).toHaveLength(1);
    expect(map.get('claude')).toBeUndefined();
  });

  it('restores a stored snapshot and persists new ones', async () => {
    const store = new ModelSnapshotStore(new InMemoryMemento());
    const service = new ModelCatalogService(store, debug);
    expect(service.restore(WORK_ID)).toBeUndefined();
    const snapshots = new Map([['openai', [routedModel()]] as const]);
    await service.persistSnapshot(WORK_ID, snapshots, [routedModel()]);
    expect(service.restore(WORK_ID)?.models).toHaveLength(1);
  });

  it('swallows snapshot store failures instead of breaking refresh', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_key: string) => undefined as T,
    } as never);
    const memento = new InMemoryMemento();
    memento.failUpdates = true;
    const service = new ModelCatalogService(new ModelSnapshotStore(memento), debug);
    await expect(service.persistSnapshot(WORK_ID, new Map(), [])).resolves.toBeUndefined();
    await expect(service.clearSnapshot(WORK_PROFILE)).resolves.toBeUndefined();
    await expect(service.deleteProfile(WORK_ID)).resolves.toBeUndefined();
    await expect(service.clearAll()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });

  it('reports route refresh failures through the debug logger', () => {
    const service = new ModelCatalogService(new ModelSnapshotStore(new InMemoryMemento()), debug);
    service.reportRouteRefreshFailure({ profileName: 'work', debug: false } as never, 'openai', new Error('boom'));
    expect(debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('openai route unavailable'));
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

  it('computes a stable catalog revision from profile settings', () => {
    const values: Record<string, unknown> = {};
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => values[key] as T | undefined,
    } as never);
    const first = catalogRevision(WORK_PROFILE);
    const second = catalogRevision(WORK_PROFILE);
    expect(first).toBe(second);
    expect(catalogRevision({ ...WORK_PROFILE, baseUrl: 'https://other.example.test/v1' })).not.toBe(first);

    values.openaiApiStrategy = 'chat';
    expect(catalogRevision(WORK_PROFILE)).not.toBe(first);
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
