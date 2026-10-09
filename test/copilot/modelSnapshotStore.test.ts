import { describe, expect, it } from 'vitest';
import { MAX_SNAPSHOT_MODELS, ModelSnapshotStore, parseModelSnapshot } from '../../src/copilot/modelSnapshotStore';
import type { RoutedModel } from '../../src/relay/types';
import { MODEL_SNAPSHOT_KEY_PREFIX } from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const A = 'a'.repeat(64); const B = 'b'.repeat(64);
const key = (id = ID, rev = A) => `${MODEL_SNAPSHOT_KEY_PREFIX}${id}.${rev}`;
function model(overrides: Partial<RoutedModel> = {}): RoutedModel {
  return { id: 'model', upstreamId: 'model', pickerId: 'model', apiType: 'chat-completions', catalogSource: 'discovery', ...overrides };
}
function record(directory: RoutedModel[] = [model()]) {
  return { schemaVersion: 3, profileId: ID, catalogRevision: A, savedAt: Date.now(), directory };
}
function legacy(state: InMemoryMemento, rev = A) {
  const models = [{ id: 'model', upstreamId: 'model', pickerId: 'model', protocol: 'openai', route: 'chatgpt',
    openaiApi: 'responses', catalogSource: 'discovery' }];
  state.values.set(`weavenet-copilot.modelSnapshots.v2.${ID}.${rev}`, {
    schemaVersion: 2, profileId: ID, catalogRevision: rev, savedAt: Date.now(), models,
    snapshots: { openai: models, chatgpt: [], claude: [] },
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class DelayedState extends InMemoryMemento {
  readonly started = deferred(); readonly release = deferred(); calls = 0;
  override async update(key: string, value: unknown) { if (++this.calls === 1) { this.started.resolve(); await this.release.promise; } await super.update(key, value); }
}

describe('single directory snapshot storage', () => {
  it('stores exactly one discovered directory, without route maps or a duplicate final list', async () => {
    const state = new InMemoryMemento(); const store = new ModelSnapshotStore(state);
    const directory = [model(), model({ id: 'native', upstreamId: 'native', pickerId: 'native', apiType: 'messages' })];
    await store.update(ID, A, directory);
    expect(store.get(ID, A)?.directory).toEqual(directory);
    expect(state.get(key())).not.toHaveProperty('models'); expect(state.get(key())).not.toHaveProperty('snapshots');
  });
  it('requires matching profile and credential-bound revision', async () => {
    const state = new InMemoryMemento(); const store = new ModelSnapshotStore(state); await store.update(ID, A, [model()]);
    expect(store.get(ID, B)).toBeUndefined(); expect(store.get(OTHER, A)).toBeUndefined(); expect(store.get(ID, 'bad')).toBeUndefined();
  });
  it('bounds the directory and prunes old revisions only after a successful write', async () => {
    const state = new InMemoryMemento(); const store = new ModelSnapshotStore(state);
    await store.update(ID, A, [model()]);
    const directory = Array.from({ length: MAX_SNAPSHOT_MODELS + 50 }, (_, i) => model({ id: `m${i}`, upstreamId: `m${i}`, pickerId: `m${i}` }));
    await store.update(ID, B, directory);
    expect(store.get(ID, B)?.directory).toHaveLength(MAX_SNAPSHOT_MODELS); expect(state.values.has(key(ID, A))).toBe(false);
  });
  it('upgrades a verified v2 record through the migration boundary, preserving API and timestamp', async () => {
    const state = new InMemoryMemento(); legacy(state); const old = state.get<{ savedAt: number }>(`weavenet-copilot.modelSnapshots.v2.${ID}.${A}`)!;
    const store = new ModelSnapshotStore(state); const restored = store.get(ID, A);
    expect(restored).toMatchObject({ schemaVersion: 3, savedAt: old.savedAt, directory: [expect.objectContaining({ apiType: 'responses' })] });
    expect(restored?.directory[0]).not.toHaveProperty('route'); expect(restored?.directory[0]).not.toHaveProperty('protocol');
    await store.update(ID, A, restored!.directory, restored!.savedAt);
    expect(state.values.has(`weavenet-copilot.modelSnapshots.v2.${ID}.${A}`)).toBe(false);
    expect(store.get(ID, A)?.savedAt).toBe(old.savedAt);
  });
  it('does not upgrade a v2 record for another credential revision or unbound v1 data', () => {
    const state = new InMemoryMemento(); legacy(state, B);
    state.values.set(`weavenet-copilot.modelSnapshots.v1.${ID}`, { models: [model()] });
    expect(new ModelSnapshotStore(state).get(ID, A)).toBeUndefined();
  });
  it('preserves the original legacy record when best-effort upgrade persistence fails', async () => {
    const state = new InMemoryMemento(); legacy(state); state.failUpdates = true;
    const restored = new ModelSnapshotStore(state).get(ID, A); expect(restored?.directory[0].apiType).toBe('responses');
    await Promise.resolve(); await Promise.resolve();
    expect(state.values.has(`weavenet-copilot.modelSnapshots.v2.${ID}.${A}`)).toBe(true);
  });
  it('orders deletion after a pending write so an old task cannot resurrect a removed directory', async () => {
    const state = new DelayedState(); const store = new ModelSnapshotStore(state);
    const update = store.update(ID, A, [model()]); await state.started.promise;
    const remove = store.deleteProfile(ID); state.release.resolve(); await update; await remove;
    expect(store.get(ID, A)).toBeUndefined();
  });
  it('orders clearing after a pending legacy upgrade', async () => {
    const state = new DelayedState(); legacy(state); const store = new ModelSnapshotStore(state);
    expect(store.get(ID, A)).toBeDefined(); await state.started.promise;
    const clear = store.clear(); state.release.resolve(); await clear;
    expect(state.values.size).toBe(0);
  });
  it('deletes only the selected profile and clears all supported storage versions', async () => {
    const state = new InMemoryMemento(); const store = new ModelSnapshotStore(state);
    await store.update(ID, A, [model()]); await store.update(OTHER, A, [model()]); legacy(state);
    await store.deleteProfile(ID); expect(store.get(OTHER, A)).toBeDefined(); expect(store.get(ID, A)).toBeUndefined();
    await store.clear(); expect(state.values.size).toBe(0);
  });
});

describe('canonical snapshot validation', () => {
  it.each([undefined, null, {}, { ...record(), schemaVersion: 2 }, { ...record(), profileId: '' },
    { ...record(), catalogRevision: 'bad' }, { ...record(), savedAt: NaN }, { ...record(), savedAt: Date.now() + 90_000_000 },
    { ...record(), directory: {} }, { ...record(), directory: [model({ apiType: 'bogus' as never })] },
    { ...record(), directory: [model({ id: '' })] }, { ...record(), directory: [model({ upstreamId: '' })] },
    { ...record(), directory: [model({ pickerId: '' })] },
    { ...record(), directory: Array.from({ length: MAX_SNAPSHOT_MODELS + 1 }, () => model()) },
  ])('rejects corrupt or non-canonical records %#', value => { expect(parseModelSnapshot(value)).toBeUndefined(); });
  it('ignores wrong identities and restores absent source markers as discovery', () => {
    expect(parseModelSnapshot(record(), OTHER, A)).toBeUndefined(); expect(parseModelSnapshot(record(), ID, B)).toBeUndefined();
    const value = model(); delete (value as Partial<RoutedModel>).catalogSource;
    expect(parseModelSnapshot(record([value]))?.directory[0].catalogSource).toBe('discovery');
  });
});
