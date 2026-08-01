import { describe, expect, it } from 'vitest';
import { ResponsesProbeCache } from '../../src/relay/responsesProbeCache';

describe('ResponsesProbeCache', () => {
  it('stores and returns a verdict within the TTL', () => {
    const cache = new ResponsesProbeCache();
    expect(cache.get('gpt-a', 'https://relay.example.test/v1')).toBeUndefined();

    cache.set('gpt-a', 'https://relay.example.test/v1', 'responses', 10_000, 1000);
    expect(cache.get('gpt-a', 'https://relay.example.test/v1', 5000)).toBe('responses');
  });

  it('returns undefined for an expired verdict and evicts it', () => {
    const cache = new ResponsesProbeCache();
    cache.set('gpt-a', 'https://relay.example.test/v1', 'chat', 10_000, 1000);
    expect(cache.get('gpt-a', 'https://relay.example.test/v1', 20_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('keeps verdicts per connection key and per model id', () => {
    const cache = new ResponsesProbeCache();
    cache.set('gpt-a', 'conn-1', 'responses', 10_000);
    cache.set('gpt-b', 'conn-1', 'chat', 10_000);
    cache.set('gpt-a', 'conn-2', 'chat', 10_000);

    expect(cache.get('gpt-a', 'conn-1')).toBe('responses');
    expect(cache.get('gpt-b', 'conn-1')).toBe('chat');
    expect(cache.get('gpt-a', 'conn-2')).toBe('chat');
  });

  it('clears all cached verdicts', () => {
    const cache = new ResponsesProbeCache();
    cache.set('gpt-a', 'conn-1', 'responses', 10_000);
    cache.set('gpt-b', 'conn-1', 'chat', 10_000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('gpt-a', 'conn-1')).toBeUndefined();
  });
});
