import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelThinkingPart } from '../support/vscode.mock';
import { getConfig, normalizeClaudeRequestCapabilities } from '../../src/config/config';
import type { ApiType, ConfiguredModel } from '../../src/config/config';
import { toClaudeThinking } from '../../src/copilot/helpers';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import { WeaveNetChatProvider } from '../../src/copilot/provider';
import { claudePrefix } from '../../src/copilot/claudePrefix';
import { fromConfiguredModel, toChatInformation } from '../../src/relay/models';
import { PROTOCOL_REPLAY_METADATA_KEY } from '../../src/relay/replayState';
import { IMAGE_ONLY_TOOL_RESULT_TEXT } from '../../src/copilot/toolResultImageNormalization';
import { InMemoryMemento } from '../support/memento';

const ID = '11111111-1111-4111-8111-111111111111';
const A = 'a'.repeat(64);
const profile = { id: ID, name: 'Test', baseUrl: 'https://relay.example.test/v1' };
const tool = { name: 'ping', description: 'Test tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
const user = (value: string) => ({ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(value)], name: undefined });
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function request(fetch: MockInstance<typeof globalThis.fetch>, index = 0): ReturnType<typeof JSON.parse> { return JSON.parse(String(fetch.mock.calls[index][1]?.body)); }
let settings: Record<string, unknown>;

beforeEach(() => {
  settings = { claudePromptCaching: 'disabled', modelMetadataEnabled: false, sendMaxTokens: true };
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({
    get: (key: string) => settings[key], inspect: (key: string) => ({ globalValue: settings[key] }),
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

function context(apiType: ApiType, overrides: Partial<ConfiguredModel> = {}) {
  const config = getConfig({ ...profile, apiType });
  const routedModel = fromConfiguredModel({ id: 'model', apiType, toolCalling: true, thinking: true, ...overrides });
  const parts: vscode.LanguageModelResponsePart[] = [];
  return { config, routedModel, model: toChatInformation(routedModel, config, true), protocolIdentity: A,
    messages: snapshotChatRequest([user('question')] as never), options: snapshotChatResponseOptions({ tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto }),
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken,
    progress: { report(part: vscode.LanguageModelResponsePart) { parts.push(part); } }, parts, apiKey: 'synthetic', debug: vi.fn() };
}

const signed = [
  { type: 'thinking', thinking: 'original thinking', signature: 'SIG' },
  { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call_1', name: 'ping', input: { q: 'docs' } },
];
function continued(parts: readonly vscode.LanguageModelResponsePart[], original = 'question') {
  return snapshotChatRequest([user(original), { role: vscode.LanguageModelChatMessageRole.Assistant, content: [...parts], name: undefined },
    { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('result')])], name: undefined }] as never);
}

describe('signed prefix lifecycle', () => {
  it.each(['system', 'tools', 'messages'] as const)('rejects changed %s before any continuation POST', async change => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: signed, stop_reason: 'tool_use' }));
    const first = context('messages', { claude: { thinkingMode: 'manual' } });
    if (change === 'system') first.messages = snapshotChatRequest([{ role: 3, content: [new vscode.LanguageModelTextPart('old system')], name: undefined }, user('question')] as never);
    await provideClaudeResponse(first);
    const second = context('messages', { claude: { thinkingMode: 'manual' } });
    second.messages = continued(first.parts, change === 'messages' ? 'edited question' : 'question');
    if (change === 'system') second.messages = snapshotChatRequest([{ role: 3, content: [new vscode.LanguageModelTextPart('new system')], name: undefined },
      user('question'), { role: vscode.LanguageModelChatMessageRole.Assistant, content: first.parts, name: undefined },
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('result')])], name: undefined }] as never);
    if (change === 'tools') second.options = snapshotChatResponseOptions({ tools: [{ ...tool, description: 'changed tool' }], toolMode: vscode.LanguageModelChatToolMode.Auto });
    await expect(provideClaudeResponse(second)).rejects.toThrow(/earlier messages changed|tools or earlier/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('ignores moved API cache markers but preserves business cache_control values', () => {
    const request = { system: [{ type: 'text' as const, text: 'system', cache_control: { type: 'ephemeral' as const } }],
      tools: [{ name: 'ping', input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } }, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'ping', input: { cache_control: 'business A' } }] }] };
    const original = claudePrefix(request);
    expect(claudePrefix({ ...request, system: [{ type: 'text', text: 'system' }], tools: [{ name: 'ping', input_schema: request.tools[0].input_schema }] })).toEqual(original);
    expect(claudePrefix({ ...request, messages: [{ role: 'assistant', content: [{ ...request.messages[0].content[0], input: { cache_control: 'business B' } }] }] }).hash).not.toBe(original.hash);
  });

  it('rejects prefix-less old signed carriers rather than claiming they are safe', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: signed, stop_reason: 'tool_use' }));
    const first = context('messages'); await provideClaudeResponse(first);
    const oldParts = first.parts.map(part => {
      const meta = (part as unknown as { metadata?: Record<string, unknown> }).metadata;
      const state = meta?.[PROTOCOL_REPLAY_METADATA_KEY] as Record<string, unknown> | undefined;
      if (!state) return part;
      const old = { ...state }; delete old.claudePrefix;
      return new LanguageModelThinkingPart('', undefined, { [PROTOCOL_REPLAY_METADATA_KEY]: old }) as never;
    });
    const next = context('messages'); next.messages = continued(oldParts);
    await expect(provideClaudeResponse(next)).rejects.toThrow('no prefix fingerprint');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('declared model request capabilities', () => {
  it('omits forbidden sampling and rejects unsupported forced choice before POST', async () => {
    settings.temperature = 0.2; settings.topP = 0.4;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: [{ type: 'text', text: 'answer' }] }));
    const current = context('messages', { claude: { thinkingMode: 'adaptive', sampling: false, forcedToolChoice: false } });
    await provideClaudeResponse(current);
    expect(request(fetch)).not.toHaveProperty('temperature'); expect(request(fetch)).not.toHaveProperty('top_p');
    current.options = snapshotChatResponseOptions({ tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required });
    await expect(provideClaudeResponse(current)).rejects.toThrow('forced tool choice');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('allows declared adaptive forced choice without disabling thinking', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: [{ type: 'text', text: 'answer' }] }));
    const current = context('messages', { claude: { thinkingMode: 'adaptive', forcedToolChoice: true } });
    current.options = snapshotChatResponseOptions({ tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required, modelOptions: { reasoningEffort: 'high' } });
    await provideClaudeResponse(current);
    expect(request(fetch)).toMatchObject({ thinking: { type: 'adaptive' }, tool_choice: { type: 'any' }, output_config: { effort: 'high' } });
  });

  it('sends one supported sampler in legacy non-thinking requests', async () => {
    settings.temperature = 0.3; settings.topP = 0.5;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: [{ type: 'text', text: 'answer' }] }));
    await provideClaudeResponse(context('messages', { thinking: false, claude: { thinkingMode: 'manual', sampling: true } }));
    expect(request(fetch).temperature).toBe(0.3); expect(request(fetch)).not.toHaveProperty('top_p');
  });

  it('filters Claude-specific efforts and never sends OpenAI minimal', () => {
    expect(normalizeClaudeRequestCapabilities({ thinkingMode: 'adaptive', reasoningEfforts: ['none', 'minimal', 'low', 'xhigh'], defaultReasoningEffort: 'minimal' }))
      .toMatchObject({ reasoningEfforts: ['low', 'xhigh'], defaultReasoningEffort: undefined });
    expect(() => toClaudeThinking('minimal', 16000, 'adaptive')).toThrow('Claude adaptive effort');
  });

  it('treats model_context_window_exceeded as truncation, with no pending tool publication', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ content: signed, stop_reason: 'model_context_window_exceeded' }));
    const current = context('messages'); await provideClaudeResponse(current);
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    const marker = current.parts.find(part => !!(part as unknown as { metadata?: Record<string, unknown> }).metadata?.[PROTOCOL_REPLAY_METADATA_KEY]);
    expect(JSON.stringify(marker)).not.toContain('SIG');
  });

  it('only sends sampling at declared OpenAI reasoning effort levels', async () => {
    settings.temperature = 0.4;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
    const current = context('chat-completions', { openai: { samplingEfforts: ['none'] } });
    current.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: 'high' } });
    await provideOpenAIResponse(current); expect(request(fetch)).not.toHaveProperty('temperature');
    current.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: 'none' } });
    await provideOpenAIResponse(current); expect(request(fetch, 1).temperature).toBe(0.4);
  });

  it.each([false, undefined, true])('controls reasoning summary by both model thinking and explicit flag %s', async enabled => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }));
    const current = context('responses', { thinking: true, openai: { reasoningSummary: enabled } });
    await provideResponsesResponse(current);
    expect(request(fetch).reasoning?.summary).toBe(enabled ? 'auto' : undefined);
    const nonReasoning = context('responses', { thinking: false, openai: { reasoningSummary: true } });
    await provideResponsesResponse(nonReasoning);
    expect(request(fetch, 1)).not.toHaveProperty('reasoning');
  });

  it('does not infer sampling support from missing reasoning metadata', async () => {
    settings.temperature = 0.4;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
    const unknown = context('chat-completions', { thinking: undefined });
    await provideOpenAIResponse(unknown); expect(request(fetch)).not.toHaveProperty('temperature');
    const knownPlain = context('chat-completions', { thinking: false });
    await provideOpenAIResponse(knownPlain); expect(request(fetch, 1).temperature).toBe(0.4);
  });

  it('applies sampling capability gates in Responses as well as Chat', async () => {
    settings.temperature = 0.4; settings.topP = 0.6;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }));
    const current = context('responses', { openai: { sampling: false } });
    await provideResponsesResponse(current);
    expect(request(fetch)).not.toHaveProperty('temperature'); expect(request(fetch)).not.toHaveProperty('top_p');
    const allowed = context('responses', { openai: { samplingEfforts: ['none'] } });
    allowed.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: 'none' } });
    await provideResponsesResponse(allowed);
    expect(request(fetch, 1).temperature).toBe(0.4);
  });

  it('keeps Responses image limits and cache hints under the standard policy', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }));
    const current = context('responses', { imageInput: true, openai: { promptCacheKey: true } });
    current.messages = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')], name: undefined }] as never);
    await provideResponsesResponse(current);
    expect(request(fetch)).toHaveProperty('max_output_tokens'); expect(request(fetch)).toHaveProperty('prompt_cache_key');
    const legacy = context('responses', { imageInput: true, openai: { promptCacheKey: true, imageCompatibility: 'legacy-relay' } });
    legacy.messages = current.messages; await provideResponsesResponse(legacy);
    expect(request(fetch, 1)).not.toHaveProperty('max_output_tokens'); expect(request(fetch, 1)).not.toHaveProperty('prompt_cache_key');
  });

  it('preserves standard image parameters but allows an explicit legacy relay policy', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
    const standard = context('chat-completions', { imageInput: true, openai: { promptCacheKey: true } });
    standard.messages = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')], name: undefined }] as never);
    standard.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: 'high' } });
    await provideOpenAIResponse(standard);
    const body = request(fetch); expect(body).toHaveProperty('max_tokens'); expect(body.reasoning_effort).toBe('high'); expect(body).toHaveProperty('prompt_cache_key');
    expect(body.messages[0].content[0].image_url).not.toHaveProperty('media_type');
    const legacy = context('chat-completions', { imageInput: true, openai: { promptCacheKey: true, imageCompatibility: 'legacy-relay' } });
    legacy.messages = standard.messages; legacy.options = standard.options; await provideOpenAIResponse(legacy);
    const old = request(fetch, 1); expect(old).not.toHaveProperty('max_tokens'); expect(old).not.toHaveProperty('reasoning_effort');
    expect(old.messages[0].content[0].image_url.media_type).toBe('image/png');
  });
});

describe('counting actual supported content', () => {
  async function provider() {
    settings.profiles = [{ ...profile, apiType: 'messages', models: [{ id: 'fixed', thinking: true, apiType: 'messages', claude: { thinkingMode: 'manual' } }] }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ data: [] }));
    const instance = new WeaveNetChatProvider({ subscriptions: [], globalState: new InMemoryMemento(), secrets: {
      get: async (key: string) => key.includes('Pepper') ? 'p'.repeat(43) : 'key', store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }),
    } } as never);
    const [model] = await instance.provideLanguageModelChatInformation({ silent: true } as never, {} as never);
    return { instance, model };
  }
  it('counts a tool image as image input, without serializing Base64 into tokens', async () => {
    const { instance, model } = await provider();
    const bytes = new Uint8Array(1024 * 1024); const image = new vscode.LanguageModelDataPart(bytes, 'image/png');
    const direct = await instance.provideTokenCount(model, { role: vscode.LanguageModelChatMessageRole.User, content: [image], name: undefined } as never, {} as never);
    const nested = await instance.provideTokenCount(model, { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelToolResultPart('call', [image])], name: undefined } as never, {} as never);
    expect(direct).toBe(1370); expect(nested).toBeLessThan(direct + 100);
    expect(nested).toBeGreaterThan(direct);
    expect(IMAGE_ONLY_TOOL_RESULT_TEXT).toBeTruthy();
  });
  it('includes manual thinking text that is replayed in a tool continuation', async () => {
    const { instance, model } = await provider();
    const count = await instance.provideTokenCount(model, { role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelThinkingPart('abcdefgh'), new vscode.LanguageModelToolCallPart('call', 'ping', {})], name: undefined } as never, {} as never);
    const without = await instance.provideTokenCount(model, { role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelToolCallPart('call', 'ping', {})], name: undefined } as never, {} as never);
    expect(count - without).toBe(2);
  });
});
