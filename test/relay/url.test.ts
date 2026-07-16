import { describe, expect, it } from 'vitest';
import { normalizeRelayBaseUrl, relayEndpointUrl } from '../../src/relay/url';

describe('Relay URL handling', () => {
  it('normalizes an HTTP(S) base URL while preserving its API path', () => {
    expect(normalizeRelayBaseUrl(' https://relay.example.com/v1/ ')).toBe('https://relay.example.com/v1');
    expect(relayEndpointUrl('https://relay.example.com/v1/', '/chat/completions')).toBe(
      'https://relay.example.com/v1/chat/completions',
    );
  });

  it('rejects URL credentials, query strings, fragments, and unsupported schemes', () => {
    expect(normalizeRelayBaseUrl('https://token@relay.example.com/v1')).toBeUndefined();
    expect(normalizeRelayBaseUrl('https://relay.example.com/v1?token=secret')).toBeUndefined();
    expect(normalizeRelayBaseUrl('https://relay.example.com/v1#secret')).toBeUndefined();
    expect(normalizeRelayBaseUrl('file:///tmp/relay')).toBeUndefined();
  });
});