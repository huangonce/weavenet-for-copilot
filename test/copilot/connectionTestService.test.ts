import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../src/config/config';
import { ConnectionTestService } from '../../src/copilot/connectionTestService';
import { RelayClient } from '../../src/relay/client';

const PROFILE: ConnectionProfile = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Work', baseUrl: 'https://relay.example.test/v1',
  apiType: 'chat-completions',
};

afterEach(() => vi.restoreAllMocks());

function service(profile: ConnectionProfile) {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: () => undefined, inspect: (key: string) => key === 'profiles' ? { globalValue: [profile] } : undefined,
  } as never);
  const store = { update: vi.fn().mockResolvedValue(undefined) };
  const instance = new ConnectionTestService({
    auth: { getApiKey: vi.fn().mockResolvedValue('key') } as never,
    diagnosticsStore: store as never, onTestStatus: vi.fn(),
  });
  vi.spyOn(RelayClient.prototype, 'testModels').mockResolvedValue({ models: { data: [{ id: 'same' }] },
    diagnostic: { endpoint: '/models', status: 200, responseType: 'json' } });
  return { instance, store };
}

describe('configured protocol connection diagnostics', () => {
  it('tests both explicitly configured APIs sharing an ID, plus the configured modern Chat field', async () => {
    const profile = { ...PROFILE, models: [
      { id: 'same', apiType: 'messages' as const }, { id: 'same', apiType: 'responses' as const },
      { id: 'modern', apiType: 'chat-completions' as const, openai: { tokenLimitField: 'max_completion_tokens' as const } },
    ] };
    const { instance, store } = service(profile);
    const native = vi.spyOn(RelayClient.prototype, 'testClaudeMessages').mockResolvedValue({
      endpoint: '/messages', status: 200, responseType: 'json', stream: false });
    const responses = vi.spyOn(RelayClient.prototype, 'testOpenAIResponses').mockResolvedValue({
      endpoint: '/responses', status: 200, responseType: 'json', stream: false });
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });
    const result = await instance.test(profile);
    expect(native).toHaveBeenCalledTimes(2);
    expect(responses).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls.every((call) => call[3] === 'max_completion_tokens')).toBe(true);
    expect(result.probes).toHaveLength(7);
    expect(result.overall).toBe('success');
    expect(result.capabilities.responses?.mode).toBe('streaming');
    expect(store.update).toHaveBeenCalledOnce();
  });

  it('never performs unbounded paid tests for models that omit token limits', async () => {
    const profile = { ...PROFILE, models: [{ id: 'same', openai: { tokenLimitField: 'omit' as const } }] };
    const { instance } = service(profile);
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion');
    const result = await instance.test(profile);
    expect(chat).not.toHaveBeenCalled();
    expect(result.overall).toBe('degraded');
    expect(result.probes[1].failure?.message).toContain('bounded generation tests');
  });
});
