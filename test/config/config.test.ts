import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  getConfig,
  isValidProfileId,
  isValidProfileName,
  normalizeConnectionProfiles,
} from '../../src/config/config';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.restoreAllMocks());

describe('connection profiles', () => {
  it('normalizes valid profiles and rejects invalid or duplicate identities', () => {
    const profiles = normalizeConnectionProfiles([
      {
        id: WORK_ID.toUpperCase(),
        name: ' Work ',
        baseUrl: ' https://relay.example.com/v1/ ',
        apiKey: 'must-not-be-used',
        requestHeaders: { 'X-Tenant': 'work', Ignored: 42 },
        includeModels: ['^gpt-', '  '],
        excludeModels: ['deprecated'],
        models: [{ id: 'private-model', route: 'openai' }],
      },
      { id: WORK_ID, name: 'Other ID duplicate', baseUrl: 'https://another.example.com/v1' },
      { id: PERSONAL_ID, name: 'Work', baseUrl: 'https://another.example.com/v1' },
      { id: 'not-a-uuid', name: 'Invalid ID', baseUrl: 'https://relay.example.com/v1' },
      { id: PERSONAL_ID, name: 'Missing endpoint' },
    ]);

    expect(profiles).toEqual([{
      id: WORK_ID,
      name: 'Work',
      baseUrl: 'https://relay.example.com/v1',
      requestHeaders: { 'X-Tenant': 'work' },
      includeModels: ['^gpt-'],
      excludeModels: ['deprecated'],
      models: [{ id: 'private-model', route: 'openai' }],
    }]);
  });

  it('normalizes the openaiApi protocol of fixed models', () => {
    const profiles = normalizeConnectionProfiles([
      {
        id: '10000000-0000-4000-8000-000000000010',
        name: 'Protocols',
        baseUrl: 'https://relay.example.com/v1',
        models: [
          { id: 'explicit-responses', route: 'openai', openaiApi: 'responses' },
          { id: 'explicit-chat', route: 'openai', openaiApi: 'chat' },
          { id: 'unspecified', route: 'openai', openaiApi: 'bogus' },
        ],
      },
    ]);

    expect(profiles[0].models).toEqual([
      { id: 'explicit-responses', route: 'openai', openaiApi: 'responses' },
      { id: 'explicit-chat', route: 'openai', openaiApi: 'chat' },
      { id: 'unspecified', route: 'openai' },
    ]);
  });

  it('keeps an empty profile list unconfigured', () => {
    expect(normalizeConnectionProfiles([])).toEqual([]);
  });

  it('rejects unsafe endpoint forms and protected request headers', () => {
    const profiles = normalizeConnectionProfiles([
      { id: '10000000-0000-4000-8000-000000000001', name: 'Credentials', baseUrl: 'https://key@relay.example.com/v1' },
      { id: '10000000-0000-4000-8000-000000000002', name: 'Query', baseUrl: 'https://relay.example.com/v1?token=secret' },
      { id: '10000000-0000-4000-8000-000000000003', name: 'Fragment', baseUrl: 'https://relay.example.com/v1#secret' },
      {
        id: WORK_ID,
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
      id: WORK_ID,
      name: 'Safe',
      baseUrl: 'https://relay.example.com/v1',
      requestHeaders: { 'X-Tenant': 'team-a' },
      includeModels: undefined,
      excludeModels: undefined,
      models: undefined,
    }]);
  });

  it('validates UUIDs and rejects unsafe connection names', () => {
    expect(isValidProfileId(WORK_ID)).toBe(true);
    expect(isValidProfileId(WORK_ID.toUpperCase())).toBe(true);
    expect(isValidProfileId('not-a-uuid')).toBe(false);
    expect(isValidProfileName('Normal connection')).toBe(true);
    expect(isValidProfileName('bad\nname')).toBe(false);
    expect(isValidProfileName('x'.repeat(101))).toBe(false);
  });
});

describe('connection-scoped route settings', () => {
  function mockConfiguration(values: Record<string, unknown>): void {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => values[key] as T | undefined,
    } as never);
  }

  it('uses only the explicitly selected profile route settings', () => {
    mockConfiguration({
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy' },
      models: [{ id: 'legacy-private', route: 'claude' }],
    });
    const profile = normalizeConnectionProfiles([{
      id: WORK_ID,
      name: 'Work',
      baseUrl: 'https://relay.example.test/v1',
      includeModels: ['^profile-'],
      excludeModels: [],
      requestHeaders: {},
      models: [],
    }])[0];

    const config = getConfig(profile);
    expect(config.profileId).toBe(WORK_ID);
    expect(config.includeModels.map((entry) => entry.source)).toEqual(['^profile-']);
    expect(config.excludeModels).toEqual([]);
    expect(config.requestHeaders).toEqual({});
    expect(config.models).toEqual([]);
  });

  it('does not read deprecated top-level route settings without a profile', () => {
    mockConfiguration({ includeModels: ['^legacy-'], requestHeaders: { 'X-Tenant': 'legacy' } });
    const config = getConfig();
    expect(config.baseUrl).toBe('');
    expect(config.includeModels).toEqual([]);
    expect(config.requestHeaders).toEqual({});
    expect(config.models).toEqual([]);
  });

  it.each([
    [undefined, 'chat'],
    ['auto', 'auto'],
    ['chat', 'chat'],
    ['responses', 'responses'],
    ['invalid', 'chat'],
    [42, 'chat'],
  ])('normalizes the application-wide OpenAI API strategy %j to %s', (value, expected) => {
    mockConfiguration({ openaiApiStrategy: value });

    expect(getConfig().openaiApiStrategy).toBe(expected);
  });

  it('keeps the vision proxy opt-in and normalizes its exact model and prompt settings', () => {
    mockConfiguration({});
    expect(getConfig()).toMatchObject({
      visionProxyEnabled: false,
      visionProxyModel: '',
      visionProxyPrompt: expect.stringContaining('Describe all image attachments'),
    });

    mockConfiguration({
      visionProxyEnabled: true,
      visionProxyModel: ' copilot/gpt-4o ',
      visionProxyPrompt: ' Describe visible text. ',
    });
    expect(getConfig()).toMatchObject({
      visionProxyEnabled: true,
      visionProxyModel: 'copilot/gpt-4o',
      visionProxyPrompt: 'Describe visible text.',
    });
  });
});

describe('invalid model regexes', () => {
  it('warns only once per invalid regex across repeated getConfig calls', () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const configValues: Record<string, unknown> = { imageInputModels: ['[invalid'] };
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string) => configValues[key] as T | undefined,
    } as never);

    getConfig();
    getConfig();
    getConfig();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[invalid'));
  });
});
