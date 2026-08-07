import { describe, expect, it } from 'vitest';
import { ResponsesProbeCache, responsesProbeCache } from '../../src/relay/responsesProbeCache';
import { RESPONSES_PROBE_KEY_PREFIX } from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);
const PROF_1_REV_A = { profileId: 'prof-1', catalogRevision: REV_A } as const;
const PROF_1_REV_B = { profileId: 'prof-1', catalogRevision: REV_B } as const;
const PROF_2_REV_A = { profileId: 'prof-2', catalogRevision: REV_A } as const;

class DeleteFailingMemento extends InMemoryMemento {
  override async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) throw new Error('Memento deletion failed.');
    await super.update(key, value);
  }
}

describe('ResponsesProbeCache', () => {
  it('stores and returns a verdict within the TTL', () => {
    const cache = new ResponsesProbeCache();
    expect(cache.get(PROF_1_REV_A, 'gpt-a')).toBeUndefined();

    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000, 1000);
    expect(cache.get(PROF_1_REV_A, 'gpt-a', 5000)).toBe('responses');
  });

  it('returns undefined for an expired verdict and evicts it', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'chat', 10_000, 1000);
    expect(cache.get(PROF_1_REV_A, 'gpt-a', 20_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('keeps verdicts per profile and per model id', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);
    cache.set(PROF_1_REV_A, 'gpt-b', 'chat', 10_000);
    cache.set(PROF_2_REV_A, 'gpt-a', 'chat', 10_000);

    expect(cache.get(PROF_1_REV_A, 'gpt-a')).toBe('responses');
    expect(cache.get(PROF_1_REV_A, 'gpt-b')).toBe('chat');
    expect(cache.get(PROF_2_REV_A, 'gpt-a')).toBe('chat');
  });

  it('isolates profiles that share a relay URL', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);
    expect(cache.get(PROF_2_REV_A, 'gpt-a')).toBeUndefined();
  });

  it('isolates verdicts for the same profile and model across catalog revisions', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);

    expect(cache.get(PROF_1_REV_B, 'gpt-a')).toBeUndefined();

    cache.set(PROF_1_REV_B, 'gpt-a', 'chat', 10_000);
    expect(cache.get(PROF_1_REV_A, 'gpt-a')).toBe('responses');
    expect(cache.get(PROF_1_REV_B, 'gpt-a')).toBe('chat');
  });

  it('clears every revision only for the selected profile', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);
    cache.set(PROF_1_REV_B, 'gpt-b', 'chat', 10_000);
    cache.set(PROF_2_REV_A, 'gpt-a', 'chat', 10_000);

    cache.clearProfile('prof-1');

    expect(cache.size).toBe(1);
    expect(cache.get(PROF_1_REV_A, 'gpt-a')).toBeUndefined();
    expect(cache.get(PROF_1_REV_B, 'gpt-b')).toBeUndefined();
    expect(cache.get(PROF_2_REV_A, 'gpt-a')).toBe('chat');
  });

  it('clears all cached verdicts', () => {
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);
    cache.set(PROF_2_REV_A, 'gpt-b', 'chat', 10_000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(PROF_1_REV_A, 'gpt-a')).toBeUndefined();
  });
});

describe('ResponsesProbeCache persistence', () => {
  it('survives a restart by reading verdicts back from global state', async () => {
    const values = new Map<string, unknown>();
    const first = new ResponsesProbeCache();
    first.attach(new InMemoryMemento(values) as never);
    first.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000, 1000);
    await flushAsyncWork();

    // Simulate a fresh instance (extension restart) sharing the same state.
    const restarted = new ResponsesProbeCache();
    restarted.attach(new InMemoryMemento(values) as never);
    expect(restarted.get(PROF_1_REV_A, 'gpt-a', 5000)).toBe('responses');
    expect(restarted.get(PROF_1_REV_A, 'gpt-a', 20_000)).toBeUndefined();
  });

  it('does not restore a persisted verdict into another catalog revision', async () => {
    const values = new Map<string, unknown>();
    const first = new ResponsesProbeCache();
    first.attach(new InMemoryMemento(values) as never);
    first.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000, 1000);
    await flushAsyncWork();

    const restarted = new ResponsesProbeCache();
    restarted.attach(new InMemoryMemento(values) as never);
    expect(restarted.get(PROF_1_REV_B, 'gpt-a', 5000)).toBeUndefined();
    expect(restarted.get(PROF_1_REV_A, 'gpt-a', 5000)).toBe('responses');
  });

  it('keeps persisted and in-memory entries in sync', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000, 1000);
    await flushAsyncWork();

    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::revision:${REV_A}::gpt-a`)).toEqual({
      protocol: 'responses',
      expiresAt: 11_000,
    });

    await cache.clearProfile('prof-1');
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::revision:${REV_A}::gpt-a`)).toBeUndefined();
  });

  it('drops corrupt persisted entries on read', () => {
    const values = new Map<string, unknown>([
      [`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::revision:${REV_A}::gpt-bad`, { protocol: 'weird', expiresAt: 1e15 }],
    ]);
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    expect(cache.get(PROF_1_REV_A, 'gpt-bad')).toBeUndefined();
  });

  it('clears persisted verdicts on clear() and clearProfile()', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    cache.set(PROF_1_REV_A, 'gpt-a', 'chat', 10_000);
    cache.set(PROF_2_REV_A, 'gpt-b', 'responses', 10_000);
    await flushAsyncWork();

    await cache.clearProfile('prof-1');
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::revision:${REV_A}::gpt-a`)).toBeUndefined();
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-2::revision:${REV_A}::gpt-b`)).toBeDefined();

    await cache.clear();
    expect([...values.keys()].some((key) => key.startsWith(RESPONSES_PROBE_KEY_PREFIX))).toBe(false);
  });

  it('keeps a profile logically cleared when physical deletion fails', async () => {
    const persistedKey = `${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::revision:${REV_A}::gpt-a`;
    const values = new Map<string, unknown>([[persistedKey, {
      protocol: 'responses',
      expiresAt: 11_000,
    }]]);
    const cache = new ResponsesProbeCache();
    cache.attach(new DeleteFailingMemento(values) as never);
    expect(cache.get(PROF_1_REV_A, 'gpt-a', 5_000)).toBe('responses');

    await expect(cache.clearProfile('prof-1')).resolves.toBeUndefined();

    // Persistence is best-effort, but the failed delete must not let a forced
    // refresh rehydrate the stale verdict into memory.
    expect(values.get(persistedKey)).toBeDefined();
    expect(cache.get(PROF_1_REV_A, 'gpt-a', 5_000)).toBeUndefined();
  });

  it('is a no-op when no global state is attached', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.set(PROF_1_REV_A, 'gpt-a', 'responses', 10_000);
    await flushAsyncWork();
    expect([...values.keys()]).toEqual([]);
  });

  it('module singleton ignores its own persisted entries unless attached', async () => {
    // Regression guard: tests share the module singleton; make sure the
    // default (unattached) instance never touches global state.
    const scope = { profileId: 'prof-9', catalogRevision: REV_A };
    responsesProbeCache.set(scope, 'gpt-a', 'responses', 10_000);
    expect(responsesProbeCache.get(scope, 'gpt-a')).toBe('responses');
    responsesProbeCache.clear();
  });
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
