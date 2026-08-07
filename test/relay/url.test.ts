import { describe, expect, it } from 'vitest';
import { normalizeRelayBaseUrl, relayEndpointUrl } from '../../src/relay/url';

describe('Relay URL handling', () => {
  it('normalizes an HTTPS base URL while preserving its API path', () => {
    expect(normalizeRelayBaseUrl(' https://relay.example.com/v1/ ')).toBe('https://relay.example.com/v1');
    expect(relayEndpointUrl('https://relay.example.com/v1/', '/chat/completions')).toBe(
      'https://relay.example.com/v1/chat/completions',
    );
  });

  it('allows HTTP only for explicit loopback hosts', () => {
    expect(normalizeRelayBaseUrl('http://localhost:8080/v1/')).toBe('http://localhost:8080/v1');
    expect(normalizeRelayBaseUrl('http://127.0.0.2:8080/v1')).toBe('http://127.0.0.2:8080/v1');
    expect(normalizeRelayBaseUrl('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1');
    expect(normalizeRelayBaseUrl('http://relay.example.com/v1')).toBeUndefined();
    expect(normalizeRelayBaseUrl('http://localhost.example.com/v1')).toBeUndefined();
    expect(normalizeRelayBaseUrl('http://127.0.0.1.example.com/v1')).toBeUndefined();
    expect(normalizeRelayBaseUrl('http://0.0.0.0:8080/v1')).toBeUndefined();
  });

  it('rejects URL credentials, query strings, fragments, and unsupported schemes', () => {
    expect(normalizeRelayBaseUrl('https://token@relay.example.com/v1')).toBeUndefined();
    expect(normalizeRelayBaseUrl('https://relay.example.com/v1?token=secret')).toBeUndefined();
    expect(normalizeRelayBaseUrl('https://relay.example.com/v1#secret')).toBeUndefined();
    expect(normalizeRelayBaseUrl('file:///tmp/relay')).toBeUndefined();
  });
});
