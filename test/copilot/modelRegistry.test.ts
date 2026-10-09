import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import { assembleModelCatalog, loadAllModels } from '../../src/copilot/modelRegistry';
import { ModelSnapshotStore } from '../../src/copilot/modelSnapshotStore';
import { getConfiguredReasoningEffort } from '../../src/copilot/helpers';
import { InMemoryMemento } from '../support/memento';
import { RelayClient } from '../../src/relay/client';
import { toRoutedModel } from '../../src/relay/models';
import * as metadata from '../../src/metadata/openrouterFallback';

const PROFILE = { id: '11111111-1111-4111-8111-111111111111', name: 'Work', baseUrl: 'https://relay.example.test/v1' };

beforeEach(() => {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never);
  vi.spyOn(metadata, 'scheduleOpenRouterRefresh').mockReturnValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('explicit connection API routing', () => {
  it.each(['chat-completions', 'responses', 'messages'] as const)('only reads /models when refreshing %s connections', async (apiType) => {
    const config = getConfig({ ...PROFILE, apiType });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'claude-test' }, { id: 'company-model' }],
    }), { headers: { 'content-type': 'application/json' } }));
    const result = await loadAllModels(config, 'key', () => {});
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('https://relay.example.test/v1/models');
    expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
    expect(result.models).toHaveLength(2);
    expect(result.models.every((model) => model.apiType === apiType)).toBe(true);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get(apiType === 'messages' ? 'x-api-key' : 'authorization'))
      .toBe(apiType === 'messages' ? 'key' : 'Bearer key');
  });

  it('honors mixed model overrides regardless of names and connection defaults', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [
      { id: 'claude-chat', capabilities: { tool_calling: true } },
      { id: 'anthropic/native' }, { id: 'company-responses' },
    ] });
    const config = getConfig({ ...PROFILE, apiType: 'chat-completions', models: [
      { id: 'anthropic/native', apiType: 'messages' },
      { id: 'company-responses', apiType: 'responses' },
    ] });
    const { models } = await loadAllModels(config, 'key', () => {});
    expect(models).toHaveLength(3);
    expect(models.find((model) => model.id === 'claude-chat')).toMatchObject({ toolCalling: true,
apiType: 'chat-completions' as const });
    expect(models.find((model) => model.id === 'anthropic/native')).toMatchObject({ apiType: 'messages' as const });
    expect(models.find((model) => model.id === 'company-responses')).toMatchObject({ apiType: 'responses' as const });
  });

  it('allows a Chat model to override a Responses connection', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [{ id: 'chat-only' }] });
    const config = getConfig({ ...PROFILE, apiType: 'responses', models: [{ id: 'chat-only', apiType: 'chat-completions' }] });
    const { models } = await loadAllModels(config, 'key', () => {});
    expect(models).toHaveLength(1);
    expect(models[0].apiType).toBe('chat-completions');
  });

  it('preserves explicitly declared API variants for a repeated ID', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [{ id: 'same' }] });
    const config = getConfig({ ...PROFILE, models: [
      { id: 'same', apiType: 'responses' }, { id: 'same', apiType: 'chat-completions' },
    ] });
    const { models } = await loadAllModels(config, 'key', () => {});
    expect(models).toHaveLength(2);
    expect(models.map(model => model.apiType)).toEqual(['chat-completions', 'responses']);
  });

  it('keeps discovered fields and lets explicit false override advertised capabilities', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [{
      id: 'model', name: 'Upstream', context_length: 100_000,
      capabilities: { tool_calling: true, vision: true, openai: { tokenLimitField: 'max_completion_tokens' } },
    }] });
    const config = getConfig({ ...PROFILE, models: [{ id: 'model', imageInput: false, openai: { promptCacheKey: false } }] });
    const { models } = await loadAllModels(config, 'key', () => {});
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: 'Upstream', toolCalling: true, imageInput: false, contextWindow: 100_000,
      openai: { tokenLimitField: 'max_completion_tokens', promptCacheKey: false }, metadataSources: { toolCalling: 'api' } });
    expect(models[0].metadataSources?.imageInput).toBeUndefined();
  });

  it('retains the directory snapshot and fixed models when discovery fails', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValueOnce({ data: [{ id: 'available' }] }).mockRejectedValueOnce(new Error('offline'));
    const config = getConfig({ ...PROFILE, models: [{ id: 'fixed', apiType: 'responses', toolCalling: true }] });
    const first = await loadAllModels(config, 'key', () => {});
    const second = await loadAllModels(config, 'key', () => {}, first.directory);
    expect(second.directoryError).toBeInstanceOf(Error);
    expect(second.models.map((model) => model.id)).toEqual(['available', 'fixed']);
  });

  it('uses fixed models even without a directory or API key', async () => {
    const list = vi.spyOn(RelayClient.prototype, 'listModels');
    const config = getConfig({ ...PROFILE, apiType: 'messages', models: [{ id: 'private', toolCalling: true }] });
    const result = await loadAllModels(config, undefined, () => {});
    expect(list).not.toHaveBeenCalled();
    expect(result.models[0].apiType).toBe('messages');
  });

  it('assembles the same API variants and overrides after a serialized offline restart', async () => {
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [
      { id: 'shared', name: 'Upstream', context_length: 100_000, capabilities: { vision: true, tool_calling: true } },
      { id: 'hidden' },
    ] });
    const config = { ...getConfig({ ...PROFILE, apiType: 'messages', includeModels: ['^(shared|fixed)$'], models: [
      { id: 'shared', apiType: 'responses', imageInput: false },
      { id: 'shared', toolCalling: false },
      { id: 'fixed', toolCalling: true },
    ] }), modelMetadataEnabled: false };
    const online = await loadAllModels(config, 'key', () => {});
    const state = new InMemoryMemento();
    const revision = 'a'.repeat(64);
    await new ModelSnapshotStore(state).update(PROFILE.id, revision, online.directory);
    for (const [key, value] of state.values) state.values.set(key, JSON.parse(JSON.stringify(value)));
    const restored = new ModelSnapshotStore(state).get(PROFILE.id, revision)!;
    const offline = assembleModelCatalog(config, restored.directory);
    expect(offline).toEqual(online.models);
    expect(offline.map(model => [model.upstreamId, model.apiType, model.pickerId])).toEqual([
      ['fixed', 'messages', 'fixed'], ['shared', 'messages', 'shared::messages'], ['shared', 'responses', 'shared::responses'],
    ]);
    expect(offline[1]).toMatchObject({ name: 'Upstream', toolCalling: false, imageInput: true, contextWindow: 100_000 });
    expect(offline[2]).toMatchObject({ toolCalling: true, imageInput: false });
    expect(restored.directory.map(model => model.id)).toEqual(['shared', 'shared', 'hidden']);
    expect(restored).not.toHaveProperty('models');
    expect(restored).not.toHaveProperty('snapshots');
  });

  it('recovers missing API variants and their capabilities from a verified v2 directory', async () => {
    const config = { ...getConfig({ ...PROFILE, models: [
      { id: 'shared', apiType: 'responses', imageInput: false },
      { id: 'shared', apiType: 'chat-completions' },
    ] }), modelMetadataEnabled: false };
    const state = new InMemoryMemento();
    const revision = 'b'.repeat(64);
    const cached = [{ id: 'shared', upstreamId: 'shared', pickerId: 'shared', protocol: 'openai', route: 'openai',
      openaiApi: 'chat', toolCalling: true, imageInput: true, maxInputTokens: 64_000 }];
    state.values.set(`weavenet-copilot.modelSnapshots.v2.${PROFILE.id}.${revision}`, {
      schemaVersion: 2, profileId: PROFILE.id, catalogRevision: revision, savedAt: Date.now(), models: cached,
      snapshots: { openai: cached, chatgpt: [], claude: [] },
    });
    const restored = new ModelSnapshotStore(state).get(PROFILE.id, revision)!;
    const offline = assembleModelCatalog(config, restored.directory);
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [
      { id: 'shared', max_input_tokens: 64_000, capabilities: { tool_calling: true, vision: true } },
    ] });
    const online = await loadAllModels(config, 'key', () => {});
    const capabilities = (models: typeof online.models) => models.map(model => ({
      pickerId: model.pickerId, apiType: model.apiType, toolCalling: model.toolCalling,
      imageInput: model.imageInput, maxInputTokens: model.maxInputTokens,
    }));
    expect(capabilities(offline)).toEqual(capabilities(online.models));
    expect(capabilities(offline)).toEqual([
      { pickerId: 'shared::chat-completions', apiType: 'chat-completions', toolCalling: true, imageInput: true, maxInputTokens: 64_000 },
      { pickerId: 'shared::responses', apiType: 'responses', toolCalling: true, imageInput: false, maxInputTokens: 64_000 },
    ]);
  });

  it.each(['chat-completions', 'responses', 'messages'] as const)('removes inherited defaults excluded by a %s effort override', (apiType) => {
    const config = { ...getConfig({ ...PROFILE, apiType, models: [{ id: 'effort',
      ...(apiType === 'messages' ? { claude: { reasoningEfforts: ['low' as const] } }
        : { openai: { reasoningEfforts: ['low' as const] } }),
    }] }), modelMetadataEnabled: false };
    const directory = [toRoutedModel({ id: 'effort', capabilities: { reasoning: true,
      claude: { thinkingMode: 'adaptive', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
      openai: { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    } }, apiType)];
    const [model] = assembleModelCatalog(config, directory);
    const capabilities = apiType === 'messages' ? model.claude : model.openai;
    expect(capabilities?.reasoningEfforts).toEqual(['low']);
    expect(capabilities?.defaultReasoningEffort).toBeUndefined();
    expect(getConfiguredReasoningEffort(model, {} as never)).toBe(apiType === 'messages' ? 'low' : undefined);
    expect(getConfiguredReasoningEffort(model, { modelOptions: { reasoningEffort: 'high' } } as never)).toBe(apiType === 'messages' ? 'low' : undefined);
    expect(getConfiguredReasoningEffort(model, { modelOptions: { reasoningEffort: 'low' } } as never)).toBe('low');
  });

  it('does not refresh or use public metadata when disabled', async () => {
    vi.spyOn(metadata, 'enrichModelsWithOpenRouter').mockImplementation((models) => models.map((model) => ({ ...model, imageInput: true })));
    vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [{ id: 'unknown' }] });
    const config = { ...getConfig(PROFILE), modelMetadataEnabled: false };
    const result = await loadAllModels(config, 'key', () => {});
    expect(metadata.scheduleOpenRouterRefresh).not.toHaveBeenCalled();
    expect(metadata.enrichModelsWithOpenRouter).not.toHaveBeenCalled();
    expect(result.models[0].imageInput).toBeUndefined();
  });
});
