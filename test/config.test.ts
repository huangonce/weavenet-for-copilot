import { describe, expect, it } from 'vitest';
import { normalizeConnectionProfiles, selectActiveProfile } from '../src/config/config';

describe('connection profiles', () => {
  it('normalizes valid profiles and rejects invalid or duplicate entries', () => {
    const profiles = normalizeConnectionProfiles([
      {
        name: ' Work ',
        baseUrl: ' https://relay.example.com/v1/ ',
        apiKey: 'must-not-be-used',
        requestHeaders: { 'X-Tenant': 'work', Ignored: 42 },
        includeModels: ['^gpt-', '  '],
        excludeModels: ['deprecated'],
        models: [{ id: 'private-model', route: 'openai' }],
      },
      { name: 'Work', baseUrl: 'https://another.example.com/v1' },
      { name: 'Missing endpoint' },
      { name: '', baseUrl: 'https://relay.example.com/v1' },
    ]);

    expect(profiles).toEqual([{
      name: 'Work',
      baseUrl: 'https://relay.example.com/v1',
      requestHeaders: { 'X-Tenant': 'work' },
      includeModels: ['^gpt-'],
      excludeModels: ['deprecated'],
      models: [{ id: 'private-model', route: 'openai' }],
    }]);
  });

  it('selects only an existing active profile', () => {
    const profiles = normalizeConnectionProfiles([
      { name: 'Work', baseUrl: 'https://relay.example.com/v1' },
    ]);
    expect(selectActiveProfile(profiles, ' Work ')?.name).toBe('Work');
    expect(selectActiveProfile(profiles, 'Missing')).toBeUndefined();
    expect(selectActiveProfile(profiles, '')).toBeUndefined();
  });

  it('keeps an empty profile list unconfigured', () => {
    expect(normalizeConnectionProfiles([])).toEqual([]);
    expect(selectActiveProfile([], '')).toBeUndefined();
  });

  it('rejects unsafe endpoint forms and protected request headers', () => {
    const profiles = normalizeConnectionProfiles([
      { name: 'Credentials', baseUrl: 'https://key@relay.example.com/v1' },
      { name: 'Query', baseUrl: 'https://relay.example.com/v1?token=secret' },
      { name: 'Fragment', baseUrl: 'https://relay.example.com/v1#secret' },
      {
        name: 'Safe',
        baseUrl: 'https://relay.example.com/v1/',
        requestHeaders: {
          Authorization: 'Bearer attacker-value',
          'X-API-Key': 'attacker-value',
          'Content-Type': 'text/plain',
          'X-Tenant': 'team-a',
        },
      },
    ]);

    expect(profiles).toEqual([{
      name: 'Safe',
      baseUrl: 'https://relay.example.com/v1',
      requestHeaders: { 'X-Tenant': 'team-a' },
      includeModels: undefined,
      excludeModels: undefined,
      models: undefined,
    }]);
  });
});
