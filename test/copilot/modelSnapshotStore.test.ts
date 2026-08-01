import { describe, expect, it } from 'vitest';
import { ModelSnapshotStore, parseModelSnapshot } from '../../src/copilot/modelSnapshotStore';
import type { RoutedModel } from '../../src/relay/types';
import { MODEL_SNAPSHOT_KEY_PREFIX } from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

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

describe('ModelSnapshotStore', () => {
  it('round-trips per-route snapshots and the final model list', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    const snapshots = new Map<RoutedModel['route'], RoutedModel[]>([
      ['openai', [routedModel()]],
      ['claude', [routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })]],
    ]);
    const models = [routedModel(), routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })];
    await store.update(PROFILE_ID, snapshots, models);

    const restored = store.get(PROFILE_ID);
    expect(restored).toBeDefined();
    expect(restored?.snapshots.openai).toEqual([routedModel()]);
    expect(restored?.snapshots.claude).toEqual([routedModel({ id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude' })]);
    expect(restored?.models).toEqual(models);
    expect(restored?.profileId).toBe(PROFILE_ID);
  });

  it('restores only for the matching profile id', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, new Map(), [routedModel()]);
    expect(store.get('22222222-2222-4222-8222-222222222222')).toBeUndefined();
  });

  it('deletes one profile or clears all snapshots without touching unrelated state', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, new Map(), [routedModel()]);
    await state.update('unrelated', true);

    await store.deleteProfile(PROFILE_ID);
    expect(store.get(PROFILE_ID)).toBeUndefined();

    await store.update(PROFILE_ID, new Map(), [routedModel()]);
    await store.clear();
    expect(store.get(PROFILE_ID)).toBeUndefined();
    expect(state.get('unrelated')).toBe(true);
  });

  it('stores per-route snapshots under the versioned key prefix', async () => {
    const state = new InMemoryMemento();
    const store = new ModelSnapshotStore(state as never);
    await store.update(PROFILE_ID, new Map([['openai', [routedModel()]]]), []);
    expect(state.get(`${MODEL_SNAPSHOT_KEY_PREFIX}${PROFILE_ID}`)).toMatchObject({
      schemaVersion: 1,
      profileId: PROFILE_ID,
    });
  });
});

describe('parseModelSnapshot', () => {
  it('rejects non-objects, wrong schema, and future timestamps', () => {
    expect(parseModelSnapshot(undefined)).toBeUndefined();
    expect(parseModelSnapshot('x')).toBeUndefined();
    expect(parseModelSnapshot({ schemaVersion: 99, profileId: PROFILE_ID, savedAt: 1, snapshots: {}, models: [] })).toBeUndefined();
    expect(parseModelSnapshot({ schemaVersion: 1, profileId: PROFILE_ID, savedAt: Date.now() + 2 * 24 * 60 * 60 * 1000, snapshots: {}, models: [] })).toBeUndefined();
  });

  it('rejects malformed routed models and oversized lists', () => {
    const base = { schemaVersion: 1, profileId: PROFILE_ID, savedAt: Date.now(), snapshots: {} };
    expect(parseModelSnapshot({ ...base, models: [{ id: 'x' }] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, models: [{ id: 'x', upstreamId: 'x', pickerId: 'x', protocol: 'unknown', route: 'openai' }] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, snapshots: { openai: [{ id: 'x', upstreamId: 'x', pickerId: 'x', protocol: 'openai', route: 'bad' }] }, models: [] })).toBeUndefined();
    expect(parseModelSnapshot({ ...base, models: Array.from({ length: 2_001 }, (_, index) => routedModel({ id: `m${index}` })) })).toBeUndefined();
  });

  it('parses valid snapshots and ignores missing optional routes', () => {
    const parsed = parseModelSnapshot({
      schemaVersion: 1,
      profileId: PROFILE_ID,
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
      schemaVersion: 1,
      profileId: PROFILE_ID,
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
      schemaVersion: 1,
      profileId: PROFILE_ID,
      savedAt: Date.now(),
      snapshots: {},
      models: [bogus],
    });
    expect(parsed?.models[0].catalogSource).toBe('discovery');
  });
});
