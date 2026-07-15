import { describe, expect, it } from 'vitest';
import { AuthManager } from '../src/auth/auth';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../src/constants';

class InMemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('Relay API key storage', () => {
  it('isolates a single API key for each connection profile', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);

    await secrets.store(RELAY_API_KEY_SECRET, 'default-key');
    await secrets.store(`${RELAY_API_KEY_SECRET}.profile.Work%20relay`, 'work-key');

    await expect(auth.getApiKey()).resolves.toBe('default-key');
    await expect(auth.getApiKey('Work relay')).resolves.toBe('work-key');
    await expect(auth.getApiKey('Personal relay')).resolves.toBeUndefined();
  });

  it('removes unified and legacy default keys when clearing Default Relay', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await Promise.all([
      secrets.store(RELAY_API_KEY_SECRET, 'new-key'),
      secrets.store(OPENAI_API_KEY_SECRET, 'openai-key'),
      secrets.store(CHATGPT_API_KEY_SECRET, 'gpt-key'),
      secrets.store(CLAUDE_API_KEY_SECRET, 'claude-key'),
      secrets.store(LEGACY_API_KEY_SECRET, 'legacy-key'),
    ]);

    await auth.clearApiKey();

    await expect(auth.getApiKey()).resolves.toBeUndefined();
  });

  it('moves a profile key when a connection is renamed', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await secrets.store(`${RELAY_API_KEY_SECRET}.profile.Work`, 'work-key');

    await expect(auth.moveApiKey('Work', 'Company relay')).resolves.toBe(true);
    await expect(auth.getApiKey('Work')).resolves.toBeUndefined();
    await expect(auth.getApiKey('Company relay')).resolves.toBe('work-key');
  });

  it('clears a selected connection key without touching other connections', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await Promise.all([
      secrets.store(`${RELAY_API_KEY_SECRET}.profile.Work`, 'work-key'),
      secrets.store(`${RELAY_API_KEY_SECRET}.profile.Personal`, 'personal-key'),
      secrets.store(`${RELAY_API_KEY_SECRET}.profile.Keep`, 'keep-key'),
    ]);

    await auth.clearProfileApiKey('Work');

    await expect(auth.getApiKey('Work')).resolves.toBeUndefined();
    await expect(auth.getApiKey('Personal')).resolves.toBe('personal-key');
    await expect(auth.getApiKey('Keep')).resolves.toBe('keep-key');
  });

  it('clears every current and legacy Relay key when clearing all connections', async () => {
    const secrets = new InMemorySecrets();
    const auth = new AuthManager(secrets as never);
    await Promise.all([
      secrets.store(`${RELAY_API_KEY_SECRET}.profile.Work`, 'work-key'),
      secrets.store(`${RELAY_API_KEY_SECRET}.profile.Personal`, 'personal-key'),
      secrets.store(RELAY_API_KEY_SECRET, 'default-key'),
      secrets.store(OPENAI_API_KEY_SECRET, 'openai-key'),
      secrets.store(CHATGPT_API_KEY_SECRET, 'chatgpt-key'),
      secrets.store(CLAUDE_API_KEY_SECRET, 'claude-key'),
      secrets.store(LEGACY_API_KEY_SECRET, 'legacy-key'),
    ]);

    await auth.clearAllRelayApiKeys(['Work', 'Personal']);

    await expect(auth.getApiKey('Work')).resolves.toBeUndefined();
    await expect(auth.getApiKey('Personal')).resolves.toBeUndefined();
    await expect(auth.getApiKey()).resolves.toBeUndefined();
  });
});
