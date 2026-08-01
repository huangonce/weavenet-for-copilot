import { describe, expect, it } from 'vitest';
import { ResponsesProbeCache, responsesProbeCache } from '../../src/relay/responsesProbeCache';
import { RESPONSES_PROBE_KEY_PREFIX } from '../../src/constants';
import { InMemoryMemento } from '../support/memento';

describe('ResponsesProbeCache', () => {
  it('stores and returns a verdict within the TTL', () => {
    const cache = new ResponsesProbeCache();
    expect(cache.get('prof-1', 'gpt-a')).toBeUndefined();

    cache.set('prof-1', 'gpt-a', 'responses', 10_000, 1000);
    expect(cache.get('prof-1', 'gpt-a', 5000)).toBe('responses');
  });

  it('returns undefined for an expired verdict and evicts it', () => {
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'chat', 10_000, 1000);
    expect(cache.get('prof-1', 'gpt-a', 20_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('keeps verdicts per profile and per model id', () => {
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'responses', 10_000);
    cache.set('prof-1', 'gpt-b', 'chat', 10_000);
    cache.set('prof-2', 'gpt-a', 'chat', 10_000);

    expect(cache.get('prof-1', 'gpt-a')).toBe('responses');
    expect(cache.get('prof-1', 'gpt-b')).toBe('chat');
    expect(cache.get('prof-2', 'gpt-a')).toBe('chat');
  });

  it('isolates profiles that share a relay URL', () => {
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'responses', 10_000);
    expect(cache.get('prof-2', 'gpt-a')).toBeUndefined();
  });

  it('clears only the verdicts of one profile', () => {
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'responses', 10_000);
    cache.set('prof-1', 'gpt-b', 'chat', 10_000);
    cache.set('prof-2', 'gpt-a', 'chat', 10_000);

    cache.clearProfile('prof-1');

    expect(cache.size).toBe(1);
    expect(cache.get('prof-1', 'gpt-a')).toBeUndefined();
    expect(cache.get('prof-1', 'gpt-b')).toBeUndefined();
    expect(cache.get('prof-2', 'gpt-a')).toBe('chat');
  });

  it('clears all cached verdicts', () => {
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'responses', 10_000);
    cache.set('prof-2', 'gpt-b', 'chat', 10_000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('prof-1', 'gpt-a')).toBeUndefined();
  });
});

describe('ResponsesProbeCache persistence', () => {
  it('survives a restart by reading verdicts back from global state', async () => {
    const values = new Map<string, unknown>();
    const first = new ResponsesProbeCache();
    first.attach(new InMemoryMemento(values) as never);
    first.set('prof-1', 'gpt-a', 'responses', 10_000, 1000);
    await flushAsyncWork();

    // Simulate a fresh instance (extension restart) sharing the same state.
    const restarted = new ResponsesProbeCache();
    restarted.attach(new InMemoryMemento(values) as never);
    expect(restarted.get('prof-1', 'gpt-a', 5000)).toBe('responses');
    expect(restarted.get('prof-1', 'gpt-a', 20_000)).toBeUndefined();
  });

  it('keeps persisted and in-memory entries in sync', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    cache.set('prof-1', 'gpt-a', 'responses', 10_000, 1000);
    await flushAsyncWork();

    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::gpt-a`)).toEqual({
      protocol: 'responses',
      expiresAt: 11_000,
    });

    cache.clearProfile('prof-1');
    await flushAsyncWork();
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::gpt-a`)).toBeUndefined();
  });

  it('drops corrupt persisted entries on read', () => {
    const values = new Map<string, unknown>([
      [`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::gpt-bad`, { protocol: 'weird', expiresAt: 1e15 }],
    ]);
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    expect(cache.get('prof-1', 'gpt-bad')).toBeUndefined();
  });

  it('clears persisted verdicts on clear() and clearProfile()', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.attach(new InMemoryMemento(values) as never);
    cache.set('prof-1', 'gpt-a', 'chat', 10_000);
    cache.set('prof-2', 'gpt-b', 'responses', 10_000);
    await flushAsyncWork();

    cache.clearProfile('prof-1');
    await flushAsyncWork();
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-1::gpt-a`)).toBeUndefined();
    expect(values.get(`${RESPONSES_PROBE_KEY_PREFIX}profile:prof-2::gpt-b`)).toBeDefined();

    cache.clear();
    await flushAsyncWork();
    expect([...values.keys()].some((key) => key.startsWith(RESPONSES_PROBE_KEY_PREFIX))).toBe(false);
  });

  it('is a no-op when no global state is attached', async () => {
    const values = new Map<string, unknown>();
    const cache = new ResponsesProbeCache();
    cache.set('prof-1', 'gpt-a', 'responses', 10_000);
    await flushAsyncWork();
    expect([...values.keys()]).toEqual([]);
  });

  it('module singleton ignores its own persisted entries unless attached', async () => {
    // Regression guard: tests share the module singleton; make sure the
    // default (unattached) instance never touches global state.
    responsesProbeCache.set('prof-9', 'gpt-a', 'responses', 10_000);
    expect(responsesProbeCache.get('prof-9', 'gpt-a')).toBe('responses');
    responsesProbeCache.clear();
  });
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
