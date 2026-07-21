import { describe, expect, it } from 'vitest';
import { AuthManager, profileSecretKey } from '../../src/auth/auth';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../../src/constants';

const work = { id: '11111111-1111-4111-8111-111111111111', name: 'Work relay' };
const personal = { id: '22222222-2222-4222-8222-222222222222', name: 'Personal relay' };

class InMemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

class FailingSecrets extends InMemorySecrets {
  failDeleteKey: string | undefined;
  failStoreKey: string | undefined;

  override async store(key: string, value: string): Promise<void> {
    if (key === this.failStoreKey) throw new Error('store failed');
    await super.store(key, value);
  }

  override async delete(key: string): Promise<void> {
    if (key === this.failDeleteKey) throw new Error('delete failed');
    await super.delete(key);
  }
}

function legacyProfileKey(name: string): string {
  return `${RELAY_API_KEY_SECRET}.profile.${encodeURIComponent(name)}`;
}

describe('Relay API key storage', () => {
  it('isolates API keys by stable profile UUID and prefers the UUID key', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(profileSecretKey(work.id), 'uuid-key');
    await secrets.store(legacyProfileKey(work.name), 'legacy-key');

    await expect(auth.getApiKey(work)).resolves.toBe('uuid-key');
    await expect(auth.getApiKey(personal)).resolves.toBeUndefined();
  });

  it('temporarily falls back to the legacy name-addressed key', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(legacyProfileKey(work.name), '  legacy-key  ');
    await expect(auth.getApiKey(work)).resolves.toBe('legacy-key');
  });

  it('migrates a legacy key by copying, verifying, and deleting the source', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(legacyProfileKey(work.name), 'work-key');

    await auth.migrateProfileApiKeys([work]);

    expect(secrets.values.get(profileSecretKey(work.id))).toBe('work-key');
    expect(secrets.values.has(legacyProfileKey(work.name))).toBe(false);
  });

  it('does not overwrite an existing UUID key during migration', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(profileSecretKey(work.id), 'existing-key');
    await secrets.store(legacyProfileKey(work.name), 'legacy-key');

    await auth.migrateProfileApiKeys([work]);

    await expect(auth.getApiKey(work)).resolves.toBe('existing-key');
    expect(secrets.values.get(legacyProfileKey(work.name))).toBe('legacy-key');
  });

  it('keeps the legacy key usable when migration storage fails', async () => {
    const secrets = new FailingSecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(legacyProfileKey(work.name), 'legacy-key');
    secrets.failStoreKey = profileSecretKey(work.id);

    await auth.migrateProfileApiKeys([work]);

    await expect(auth.getApiKey(work)).resolves.toBe('legacy-key');
    expect(secrets.values.has(profileSecretKey(work.id))).toBe(false);
  });

  it('keeps both copies usable when migration cannot delete the source', async () => {
    const secrets = new FailingSecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(legacyProfileKey(work.name), 'legacy-key');
    secrets.failDeleteKey = legacyProfileKey(work.name);

    await auth.migrateProfileApiKeys([work]);

    await expect(auth.getApiKey(work)).resolves.toBe('legacy-key');
    expect(secrets.values.get(legacyProfileKey(work.name))).toBe('legacy-key');
  });

  it('deletes both UUID and legacy keys for one profile without touching others', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await Promise.all([
      secrets.store(profileSecretKey(work.id), 'work-key'),
      secrets.store(legacyProfileKey(work.name), 'legacy-work-key'),
      secrets.store(profileSecretKey(personal.id), 'personal-key'),
    ]);

    await auth.clearProfileApiKey(work);

    await expect(auth.getApiKey(work)).resolves.toBeUndefined();
    await expect(auth.getApiKey(personal)).resolves.toBe('personal-key');
  });

  it('clears all current and legacy Relay keys transactionally', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await Promise.all([
      secrets.store(profileSecretKey(work.id), 'work-key'),
      secrets.store(legacyProfileKey(work.name), 'legacy-work-key'),
      secrets.store(RELAY_API_KEY_SECRET, 'default-key'),
      secrets.store(OPENAI_API_KEY_SECRET, 'openai-key'),
      secrets.store(CHATGPT_API_KEY_SECRET, 'chatgpt-key'),
      secrets.store(CLAUDE_API_KEY_SECRET, 'claude-key'),
      secrets.store(LEGACY_API_KEY_SECRET, 'legacy-key'),
    ]);

    await auth.clearAllRelayApiKeys([work]);

    expect(secrets.values.size).toBe(0);
  });

  it('restores deleted key snapshots after a clear failure', async () => {
    const secrets = new FailingSecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(profileSecretKey(work.id), 'work-key');
    await secrets.store(profileSecretKey(personal.id), 'personal-key');
    secrets.failDeleteKey = profileSecretKey(personal.id);

    await expect(auth.clearAllRelayApiKeys([work, personal])).rejects.toThrow('delete failed');
    await expect(auth.getApiKey(work)).resolves.toBe('work-key');
    await expect(auth.getApiKey(personal)).resolves.toBe('personal-key');
  });

});
