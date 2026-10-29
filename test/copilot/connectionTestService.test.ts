import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../src/config/config';
import { RELAY_API_KEY_SECRET } from '../../src/constants';
import { ConnectionDiagnosticsStore, diagnosticsOptions } from '../../src/copilot/connectionDiagnosticsStore';
import { ConnectionRuntimeManager } from '../../src/copilot/connectionRuntimeManager';
import { ConnectionTestService } from '../../src/copilot/connectionTestService';
import { RelayClient } from '../../src/relay/client';
import { InMemoryMemento } from '../support/memento';

const PROFILE: ConnectionProfile = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Work', baseUrl: 'https://relay.example.test/v1',
  apiType: 'chat-completions',
};

afterEach(() => vi.restoreAllMocks());

function service(profile: ConnectionProfile) {
  let currentProfile = profile;
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string) => key === 'modelMetadataEnabled' ? false : undefined,
    inspect: (key: string) => key === 'profiles' ? { globalValue: [currentProfile] } : undefined,
  } as never);
  const state = new InMemoryMemento();
  const store = new ConnectionDiagnosticsStore(state as never);
  vi.spyOn(store, 'update');
  const onTestStatus = vi.fn();
  const instance = new ConnectionTestService({
    auth: { getApiKey: vi.fn().mockResolvedValue('key') } as never,
    diagnosticsStore: store, onTestStatus,
  });
  vi.spyOn(RelayClient.prototype, 'testModels').mockResolvedValue({ models: { data: [{ id: 'same' }] },
    diagnostic: { endpoint: '/models', status: 200, responseType: 'json' } });
  return { instance, state, store, onTestStatus, setProfile: (value: ConnectionProfile) => { currentProfile = value; } };
}

describe('configured protocol connection diagnostics', () => {
  it('tests only models included in the selectable catalog', async () => {
    const profile = { ...PROFILE, includeModels: ['^allowed$'], models: [{ id: 'excluded-fixed' }] };
    const { instance } = service(profile);
    vi.mocked(RelayClient.prototype.testModels).mockResolvedValue({
      models: { data: [{ id: 'excluded-directory' }, { id: 'allowed' }] },
      diagnostic: { endpoint: '/models', status: 200, responseType: 'json' },
    });
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });

    const result = await instance.test(profile);

    expect(chat.mock.calls.map(call => call[0])).toEqual(['allowed', 'allowed']);
    expect(result).toMatchObject({ modelCount: 2, overall: 'success' });
  });

  it('uses merged declaration and discovered token-limit capabilities', async () => {
    const profile = { ...PROFILE, models: [
      { id: 'same', openai: { tokenLimitField: 'max_completion_tokens' as const } },
      { id: 'same', name: 'Named model' },
    ] };
    const { instance } = service(profile);
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });

    await instance.test(profile);

    expect(chat.mock.calls.map(call => call[3])).toEqual(['max_completion_tokens', 'max_completion_tokens']);
    expect(chat.mock.calls.every(call => call[2]?.isCancellationRequested === false)).toBe(true);
  });

  it('reuses unchanged tests and stops before a second probe after configuration changes', async () => {
    const profile = { ...PROFILE, requestHeaders: { 'X-Tenant': 'original' } };
    const { instance, store, onTestStatus, setProfile } = service(profile);
    let finishProbe!: () => void;
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishProbe = resolve; });
      return { endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false };
    });
    const first = instance.test(profile);
    expect(instance.test(profile)).toBe(first);
    await vi.waitFor(() => expect(finishProbe).toBeDefined());
    setProfile({ ...profile, requestHeaders: { 'X-Tenant': 'replacement' } });
    finishProbe();

    await expect(first).rejects.toMatchObject({ failure: { category: 'cancelled' } });
    expect(chat).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    expect(onTestStatus).not.toHaveBeenCalled();
  });

  it('removes a late invalidated write before saving a newer test result', async () => {
    const { instance, state, store, onTestStatus } = service(PROFILE);
    vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });
    const order: string[] = [];
    let finishWrite!: () => void;
    const update = state.update.bind(state);
    vi.spyOn(state, 'update').mockImplementationOnce(async (key, value) => {
      order.push('old write started');
      await new Promise<void>(resolve => { finishWrite = resolve; });
      await update(key, value);
      order.push('old write completed');
    }).mockImplementation(async (key, value) => {
      order.push(value === undefined ? 'old write removed' : 'new write');
      await update(key, value);
    });
    const oldTest = instance.test(PROFILE);
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    instance.invalidate(PROFILE.id);
    const newTest = instance.test(PROFILE);
    expect(newTest).not.toBe(oldTest);
    finishWrite();

    await expect(oldTest).rejects.toMatchObject({ failure: { category: 'cancelled' } });
    const newResult = await newTest;
    expect(newResult.overall).toBe('success');

    expect(order).toEqual(['old write started', 'old write completed', 'old write removed', 'new write']);
    expect(store.get(PROFILE, diagnosticsOptions())).toEqual(newResult);
    expect(onTestStatus).toHaveBeenCalledOnce();
  });

  it.each(['explicit', 'all', 'secret', 'legacySecret'] as const)(
    'preserves a new successful result while an older %s clear is pending', async (kind) => {
      const { instance, state, store } = service(PROFILE);
      vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
        endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });
      await instance.test(PROFILE);
      const order: string[] = [];
      let finishDelete!: () => void;
      const update = state.update.bind(state);
      vi.spyOn(state, 'update').mockImplementation(async (key, value) => {
        if (value === undefined) {
          order.push('delete started');
          await new Promise<void>(resolve => { finishDelete = resolve; });
          await update(key, value);
          order.push('delete completed');
        } else {
          order.push('new write');
          await update(key, value);
        }
      });
      const runtime = new ConnectionRuntimeManager({
        auth: {} as never, diagnosticsStore: store,
        catalog: { deleteProfile: vi.fn(), clearAll: vi.fn() } as never,
        debug: vi.fn(), rebuildBindings: vi.fn(), onStatusChanged: vi.fn(), onCatalogChanged: vi.fn(),
        onConnectionInvalidated: profileId => instance.invalidate(profileId),
      });
      // Directory refresh is independent of diagnostics persistence in this race.
      vi.spyOn(runtime, 'syncProfiles').mockReturnValue([]);
      vi.spyOn(runtime, 'refreshAll').mockResolvedValue(undefined);
      const clearing = kind === 'explicit' ? instance.clearDiagnostics(PROFILE)
        : kind === 'all' ? instance.clearAllDiagnostics()
          : runtime.handleSecretChange(kind === 'secret' ? `${RELAY_API_KEY_SECRET}.profileId.${PROFILE.id}` : RELAY_API_KEY_SECRET);
      await vi.waitFor(() => expect(finishDelete).toBeDefined());
      const newTest = instance.test(PROFILE);
      await vi.waitFor(() => expect(store.update).toHaveBeenCalledTimes(2));
      expect(order).toEqual(['delete started']);
      finishDelete();
      await clearing;
      const newResult = await newTest;
      expect(newResult.overall).toBe('success');
      expect(order).toEqual(['delete started', 'delete completed', 'new write']);
      expect(store.get(PROFILE, diagnosticsOptions())).toEqual(newResult);
    },
  );

  it('rejects a stale configuration without cancelling its current replacement test', async () => {
    const { instance, setProfile, store } = service(PROFILE);
    const replacement = { ...PROFILE, baseUrl: 'https://replacement.example.test/v1' };
    setProfile(replacement);
    let finishModels!: () => void;
    vi.mocked(RelayClient.prototype.testModels).mockImplementation(async () => {
      await new Promise<void>(resolve => { finishModels = resolve; });
      return { models: { data: [{ id: 'same' }] }, diagnostic: { endpoint: '/models', status: 200, responseType: 'json' } };
    });
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });
    const currentTest = instance.test(replacement);
    await vi.waitFor(() => expect(finishModels).toBeDefined());
    await expect(instance.test(PROFILE)).rejects.toMatchObject({ failure: { category: 'cancelled' } });
    expect(instance.test(replacement)).toBe(currentTest);
    finishModels();
    const result = await currentTest;
    expect(result.overall).toBe('success');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.get(replacement, diagnosticsOptions())).toEqual(result);
  });

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

  it('selects a bounded Chat candidate even when an unbounded model sorts first', async () => {
    const profile = { ...PROFILE, models: [
      { id: 'z-safe', openai: { tokenLimitField: 'max_tokens' as const } },
      { id: 'a-omit', openai: { tokenLimitField: 'omit' as const } },
    ] };
    const { instance } = service(profile);
    vi.mocked(RelayClient.prototype.testModels).mockResolvedValue({ models: { data: [] },
      diagnostic: { endpoint: '/models', status: 200, responseType: 'json' } });
    const chat = vi.spyOn(RelayClient.prototype, 'testOpenAIChatCompletion').mockResolvedValue({
      endpoint: '/chat/completions', status: 200, responseType: 'json', stream: false });
    const result = await instance.test(profile);
    expect(chat.mock.calls.map(call => [call[0], call[3]])).toEqual([
      ['z-safe', 'max_tokens'], ['z-safe', 'max_tokens'],
    ]);
    expect(result.overall).toBe('success');
  });
});
