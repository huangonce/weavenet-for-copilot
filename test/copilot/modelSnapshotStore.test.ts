import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_MODELS,
  ModelSnapshotStore,
  parseModelSnapshot,
} from '../../src/copilot/modelSnapshotStore';
import type { RoutedModel } from '../../src/relay/types';
import {
  MODEL_SNAPSHOT_KEY_PREFIX,
  MODEL_SNAPSHOT_SCHEMA_VERSION,
} from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);

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

function numberedModel(index: number): RoutedModel {
  const id = `m${index}`;
  return routedModel({ id, pickerId: id, upstreamId: id });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class DelayedFirstUpdateMemento extends InMemoryMemento {
  readonly firstUpdateStarted = deferred();
  readonly releaseFirstUpdate = deferred();
  updateCalls = 0;

  override async update(key: string, value: unknown): Promise<void> {
    this.updateCalls++;
    if (this.updateCalls === 1) {
      this.firstUpdateStarted.resolve();
      await this.releaseFirstUpdate.promise;
    }
    await super.update(key, value);
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ModelSnapshotStore', () => {
  it('round-trips per-route snapshots and the final model list', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    const snapshots = new Map<RoutedModel['route'], RoutedModel[]>([
      ['openai', [routedModel()]],
      ['claude', [routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })]],
    ]);
    const models = [routedModel(), routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })];
    await store.update(PROFILE_ID, REVISION_A, snapshots, models);

    const restored = store.get(PROFILE_ID, REVISION_A);
    expect(restored).toBeDefined();
    expect(restored?.snapshots.openai).toEqual([routedModel()]);
    expect(restored?.snapshots.claude).toEqual([routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })]);
    expect(restored?.models).toEqual(models);
    expect(restored?.profileId).toBe(PROFILE_ID);
    expect(restored?.catalogRevision).toBe(REVISION_A);
  });

  it('restores only for the matching profile id and catalog revision', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel()]);

    expect(store.get(PROFILE_ID, REVISION_A)?.models).toEqual([routedModel()]);
    expect(store.get(PROFILE_ID, REVISION_B)).toBeUndefined();
    expect(store.get(OTHER_PROFILE_ID, REVISION_A)).toBeUndefined();
  });

  it('bounds both per-route snapshots and the final model list before persisting', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    const oversized = Array.from({ length: MAX_SNAPSHOT_MODELS + 1 }, (_, index) => numberedModel(index));

    await store.update(
      PROFILE_ID,
      REVISION_A,
      new Map([['openai', oversized]]),
      oversized,
    );

    const restored = store.get(PROFILE_ID, REVISION_A);
    expect(restored).toBeDefined();
    expect(restored?.snapshots.openai).toHaveLength(MAX_SNAPSHOT_MODELS);
    expect(restored?.models).toHaveLength(MAX_SNAPSHOT_MODELS);
    expect(restored?.snapshots.openai.at(-1)?.id).toBe(`m${MAX_SNAPSHOT_MODELS - 1}`);
    expect(restored?.models.at(-1)?.id).toBe(`m${MAX_SNAPSHOT_MODELS - 1}`);
  });

  it('serializes concurrent updates so the last call wins even when the first write is delayed', async () => {
    const state = new DelayedFirstUpdateMemento();
    const store = new ModelSnapshotStore(state as never);
    const first = store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel({ id: 'old', pickerId: 'old', upstreamId: 'old' })]);
    await state.firstUpdateStarted.promise;

    const second = store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel({ id: 'new', pickerId: 'new', upstreamId: 'new' })]);
    await flushAsyncWork();
    expect(state.updateCalls).toBe(1);

    state.releaseFirstUpdate.resolve();
    await Promise.all([first, second]);

    expect(state.updateCalls).toBe(2);
    expect(store.get(PROFILE_ID, REVISION_A)?.models[0].id).toBe('new');
  });

  it('does not let a pending update escape a later profile deletion', async () => {
    const state = new DelayedFirstUpdateMemento();
    const store = new ModelSnapshotStore(state as never);
    const update = store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel()]);
    await state.firstUpdateStarted.promise;

    const deletion = store.deleteProfile(PROFILE_ID);
    await flushAsyncWork();
    expect(state.updateCalls).toBe(1);

    state.releaseFirstUpdate.resolve();
    await Promise.all([update, deletion]);

    expect(store.get(PROFILE_ID, REVISION_A)).toBeUndefined();
  });

  it('deletes one profile or clears all snapshots without touching unrelated state', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel()]);
    await store.update(PROFILE_ID, REVISION_B, new Map(), [routedModel()]);
    await state.update('unrelated', true);

    await store.deleteProfile(PROFILE_ID);
    expect(store.get(PROFILE_ID, REVISION_A)).toBeUndefined();
    expect(store.get(PROFILE_ID, REVISION_B)).toBeUndefined();

    await store.update(PROFILE_ID, REVISION_A, new Map(), [routedModel()]);
    await store.clear();
    expect(store.get(PROFILE_ID, REVISION_A)).toBeUndefined();
    expect(state.get('unrelated')).toBe(true);
  });

  it('stores per-route snapshots under the versioned key prefix', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, REVISION_A, new Map([['openai', [routedModel()]]]), []);
    expect(state.get(`${MODEL_SNAPSHOT_KEY_PREFIX}${PROFILE_ID}.${REVISION_A}`)).toMatchObject({
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
    });
  });
});

describe('parseModelSnapshot', () => {
  it('rejects non-objects, wrong schema, and future timestamps', () => {
    expect(parseModelSnapshot(undefined)).toBeUndefined();
    expect(parseModelSnapshot('x')).toBeUndefined();
    expect(parseModelSnapshot({ schemaVersion: 99, profileId: PROFILE_ID, catalogRevision: REVISION_A, savedAt: 1, snapshots: {}, models: [] })).toBeUndefined();
    expect(parseModelSnapshot({ schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION, profileId: PROFILE_ID, catalogRevision: REVISION_A, savedAt: Date.now() + 2 * 24 * 60 * 60 * 1000, snapshots: {}, models: [] })).toBeUndefined();
  });

  it('rejects malformed routed models and oversized lists', () => {
    const base = {
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
      savedAt: Date.now(),
      snapshots: {},
    };
    const oversized = Array.from({ length: MAX_SNAPSHOT_MODELS + 1 }, (_, index) => numberedModel(index));
    expect(parseModelSnapshot({ ...base, models: [{ id: 'x' }] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, models: [{ id: 'x', upstreamId: 'x', pickerId: 'x', protocol: 'unknown', route: 'openai' }] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, snapshots: { openai: [{ id: 'x', upstreamId: 'x', pickerId: 'x', protocol: 'openai', route: 'bad' }] }, models: [] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, models: oversized })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, snapshots: { openai: oversized }, models: [] })).toBeUndefined();
  });

  it('rejects records for a different profile or catalog revision', () => {
    const record = {
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
      savedAt: Date.now(),
      snapshots: {},
      models: [routedModel()],
    };
    expect(parseModelSnapshot(record, PROFILE_ID, REVISION_A)).toBeDefined();
    expect(parseModelSnapshot(record, OTHER_PROFILE_ID, REVISION_A)).toBeUndefined();
    expect(parseModelSnapshot(record, PROFILE_ID, REVISION_B)).toBeUndefined();
  });

  it('parses valid snapshots and ignores missing optional routes', () => {
    const parsed = parseModelSnapshot({
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
      savedAt: Date.now(),
      snapshots: { openai: [routedModel()] },
      models: [routedModel()],
    });
    expect(parsed).toBeDefined();
    expect(parsed?.snapshots.chatgpt).toEqual([]);
    expect(parsed?.snapshots.claude).toEqual([]);
    expect(parsed?.models[0].id).toBe('gpt-test');
  });

  it('backfills catalogSource discovery for legacy snapshots without it', () => {
    const legacy = { id: 'gpt-test', pickerId: 'gpt-test', upstreamId: 'gpt-test', protocol: 'openai', route: 'openai' };
    const parsed = parseModelSnapshot({
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
      savedAt: Date.now(),
      snapshots: { openai: [legacy] },
      models: [legacy],
    });
    expect(parsed?.snapshots.openai[0].catalogSource).toBe('discovery');
    expect(parsed?.models[0].catalogSource).toBe('discovery');
  });

  it('falls back to discovery for unknown catalogSource values', () => {
    const bogus = { id: 'gpt-test', pickerId: 'gpt-test', upstreamId: 'gpt-test', protocol: 'openai', route: 'openai', catalogSource: 'bogus' };
    const parsed = parseModelSnapshot({
      schemaVersion: MODEL_SNAPSHOT_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      catalogRevision: REVISION_A,
      savedAt: Date.now(),
      snapshots: {},
      models: [bogus],
    });
    expect(parsed?.models[0].catalogSource).toBe('discovery');
  });
});
