import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig, isValidProfileName, normalizeConnectionProfiles, selectActiveProfile } from '../../src/config/config';

afterEach(() => vi.restoreAllMocks());

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
          Cookie: 'session=attacker-value',
          'Proxy-Authorization': 'Basic attacker-value',
          TE: 'trailers',
          Upgrade: 'websocket',
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

  it('rejects control characters and excessive connection names', () => {
    expect(isValidProfileName('Normal connection')).toBe(true);
    expect(isValidProfileName('bad\nname')).toBe(false);
    expect(isValidProfileName('x'.repeat(101))).toBe(false);
    expect(normalizeConnectionProfiles([
      { name: 'bad\nname', baseUrl: 'https://relay.example.test/v1' },
      { name: 'x'.repeat(101), baseUrl: 'https://relay.example.test/v1' },
    ])).toEqual([]);
  });
});

describe('legacy connection setting compatibility', () => {
  function mockConfiguration(profile: Record<string, unknown>, legacy: Record<string, unknown>): void {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => legacy[key] as T | undefined,
      inspect: <T>(key: string) => key === 'profiles'
        ? { globalValue: [{ name: 'Work', baseUrl: 'https://relay.example.test/v1', ...profile }] as T }
        : key === 'activeProfile'
          ? { globalValue: 'Work' as T }
          : undefined,
    } as never);
  }

  it('falls back to legacy top-level route settings when a profile omits them', () => {
    mockConfiguration({}, {
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy', Authorization: 'ignored' },
      models: [{ id: 'legacy-private', route: 'claude' }],
    });

    const config = getConfig();
    expect(config.includeModels.map((entry) => entry.source)).toEqual(['^legacy-']);
    expect(config.excludeModels.map((entry) => entry.source)).toEqual(['-old$']);
    expect(config.requestHeaders).toEqual({ 'X-Tenant': 'legacy' });
    expect(config.models).toEqual([{ id: 'legacy-private', route: 'claude' }]);
  });

  it('gives explicit profile route settings priority, including empty values', () => {
    mockConfiguration({ includeModels: [], excludeModels: [], requestHeaders: {}, models: [] }, {
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy' },
      models: [{ id: 'legacy-private', route: 'claude' }],
    });

    const config = getConfig();
    expect(config.includeModels).toEqual([]);
    expect(config.excludeModels).toEqual([]);
    expect(config.requestHeaders).toEqual({});
    expect(config.models).toEqual([]);
  });
});
