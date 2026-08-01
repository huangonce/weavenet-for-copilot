import { describe, expect, it } from 'vitest';
import { ResponsesProbeCache } from '../../src/relay/responsesProbeCache';

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
