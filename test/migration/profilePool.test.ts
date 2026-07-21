import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { migrateProfilePoolConfiguration } from '../../src/migration/profilePool';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_ID = '22222222-2222-4222-8222-222222222222';

interface ConfigurationFixture {
  readonly settings: Map<string, unknown>;
  readonly updates: ReturnType<typeof vi.fn>;
  failUpdate(key: string, value: unknown): void;
}

function configurationFixture(initial: Record<string, unknown>): ConfigurationFixture {
  const settings = new Map(Object.entries(initial));
  let failure: { key: string; value: unknown } | undefined;
  const updates = vi.fn(async (key: string, value: unknown) => {
    if (failure?.key === key && Object.is(failure.value, value)) throw new Error('configuration update failed');
    if (value === undefined) settings.delete(key);
    else settings.set(key, value);
  });
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    inspect: <T>(key: string) => ({ globalValue: settings.get(key) as T | undefined }),
    update: updates,
  } as never);
  return {
    settings,
    updates,
    failUpdate(key: string, value: unknown) { failure = { key, value }; },
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('profile pool migration', () => {
  it('adds UUIDs, preserves valid UUIDs, and places the former active profile first', async () => {
    const fixture = configurationFixture({
      profiles: [
        { name: 'Personal', baseUrl: 'https://personal.example.test/v1' },
        { id: WORK_ID, name: 'Work', baseUrl: 'https://work.example.test/v1' },
      ],
      activeProfile: 'Work',
    });

    const result = await migrateProfilePoolConfiguration();

    expect(result.migrated).toBe(true);
    expect(result.profiles.map((profile) => profile.name)).toEqual(['Work', 'Personal']);
    expect(result.profiles[0].id).toBe(WORK_ID);
    expect(result.profiles[1].id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixture.settings.get('activeProfile')).toBe('');
  });

  it('regenerates duplicate valid UUIDs instead of dropping a connection', async () => {
    configurationFixture({
      profiles: [
        { id: WORK_ID, name: 'Work', baseUrl: 'https://work.example.test/v1' },
        { id: WORK_ID, name: 'Personal', baseUrl: 'https://personal.example.test/v1' },
      ],
    });

    const result = await migrateProfilePoolConfiguration();

    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0].id).toBe(WORK_ID);
    expect(result.profiles[1].id).not.toBe(WORK_ID);
  });

  it('materializes explicit legacy route settings only into the former active profile', async () => {
    configurationFixture({
      profiles: [
        { id: WORK_ID, name: 'Work', baseUrl: 'https://work.example.test/v1' },
        { id: PERSONAL_ID, name: 'Personal', baseUrl: 'https://personal.example.test/v1' },
      ],
      activeProfile: 'Personal',
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy' },
      models: [{ id: 'private-model', route: 'claude' }],
    });

    const { profiles } = await migrateProfilePoolConfiguration();

    expect(profiles[0]).toMatchObject({
      id: PERSONAL_ID,
      name: 'Personal',
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy' },
      models: [{ id: 'private-model', route: 'claude' }],
    });
    expect(profiles[1]).toMatchObject({ id: WORK_ID, name: 'Work' });
    expect(profiles[1].includeModels).toBeUndefined();
  });

  it('preserves explicit empty values on the former active profile', async () => {
    configurationFixture({
      profiles: [{
        id: WORK_ID,
        name: 'Work',
        baseUrl: 'https://work.example.test/v1',
        includeModels: [],
        excludeModels: [],
        requestHeaders: {},
        models: [],
      }],
      activeProfile: 'Work',
      includeModels: ['^legacy-'],
      excludeModels: ['-old$'],
      requestHeaders: { 'X-Tenant': 'legacy' },
      models: [{ id: 'private-model', route: 'claude' }],
    });

    const { profiles } = await migrateProfilePoolConfiguration();

    expect(profiles[0]).toMatchObject({ includeModels: [], excludeModels: [], requestHeaders: {}, models: [] });
  });

  it('is idempotent after the upgraded settings are persisted', async () => {
    const fixture = configurationFixture({
      profiles: [{ name: 'Work', baseUrl: 'https://work.example.test/v1' }],
      activeProfile: 'Work',
    });

    const first = await migrateProfilePoolConfiguration();
    fixture.updates.mockClear();
    const second = await migrateProfilePoolConfiguration();

    expect(second).toEqual({ migrated: false, profiles: first.profiles });
    expect(fixture.updates).not.toHaveBeenCalled();
  });

  it('rolls profiles and active selection back when persisting the migration fails', async () => {
    const previousProfiles = [{ name: 'Work', baseUrl: 'https://work.example.test/v1' }];
    const fixture = configurationFixture({ profiles: previousProfiles, activeProfile: 'Work' });
    fixture.failUpdate('activeProfile', '');

    await expect(migrateProfilePoolConfiguration()).rejects.toThrow('configuration update failed');

    expect(fixture.settings.get('profiles')).toEqual(previousProfiles);
    expect(fixture.settings.get('activeProfile')).toBe('Work');
  });
});
