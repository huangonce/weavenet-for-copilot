import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import type { ApiType, ConfiguredModel } from '../../src/config/config';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { getConfiguredMaxOutputTokens } from '../../src/copilot/helpers';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import { fromConfiguredModel, toChatInformation } from '../../src/relay/models';

const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Test', baseUrl: 'https://relay.example.test/v1' };
let settings: Record<string, unknown>;
let fetch: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
  settings = { modelMetadataEnabled: false, claudePromptCaching: 'disabled' };
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({ get: (key: string) => settings[key] }) as never);
  fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
    status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
    content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn',
  }), { headers: { 'content-type': 'application/json' } }));
});
afterEach(() => vi.restoreAllMocks());

function context(apiType: ApiType, modelOptions: Record<string, unknown> = {}, overrides: Partial<ConfiguredModel> = {}) {
  const config = getConfig({ ...profile, apiType });
  const routedModel = fromConfiguredModel({ id: 'model', apiType, thinking: false, ...overrides });
  return { config, routedModel, model: toChatInformation(routedModel, config, true),
    messages: snapshotChatRequest([vscode.LanguageModelChatMessage.User('hello')]),
    options: snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions }),
    progress: { report: vi.fn() },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken,
    apiKey: 'synthetic', protocolIdentity: 'a'.repeat(64), debug: vi.fn(),
  };
}
function body() { return JSON.parse(String(fetch.mock.calls[0][1]?.body)); }

const openAIProviders = [
  ['chat-completions', provideOpenAIResponse, 'max_tokens'],
  ['responses', provideResponsesResponse, 'max_output_tokens'],
] as const;
const allProviders = [...openAIProviders, ['messages', provideClaudeResponse, 'max_tokens']] as const;

describe.each(allProviders)('%s per-request options', (apiType, provide, limitField) => {
  it('honors explicit max_tokens with sendMaxTokens disabled and caps it at the current model budget', async () => {
    const request = context(apiType, { max_tokens: 9000 });
    request.model = { ...request.model, maxOutputTokens: 4000 };
    expect(request.config.sendMaxTokens).toBe(false);
    await provide(request);
    expect(body()[limitField]).toBe(4000);
  });

  it('uses a smaller explicit output limit', async () => {
    await provide(context(apiType, { max_tokens: 64 }));
    expect(body()[limitField]).toBe(64);
  });

  it('prefers per-request temperature over configured sampling', async () => {
    Object.assign(settings, { temperature: 1.2, topP: 0.9 });
    await provide(context(apiType, { temperature: 0, top_p: 0.2 }, { claude: { sampling: true } }));
    expect(body().temperature).toBe(0);
    expect(body().top_p).toBeUndefined();
  });

  it('prefers explicit top_p over the configured temperature', async () => {
    settings.temperature = 0.8;
    await provide(context(apiType, { top_p: 0.3 }, { claude: { sampling: true } }));
    expect(body().temperature).toBeUndefined();
    expect(body().top_p).toBe(0.3);
  });

  it('ignores invalid overrides and retains valid configured defaults', async () => {
    Object.assign(settings, { temperature: 0.6, sendMaxTokens: true });
    const request = context(apiType, { max_tokens: -1, temperature: NaN, top_p: 3 }, { claude: { sampling: true } });
    await provide(request);
    expect(body()[limitField]).toBe(request.model.maxOutputTokens);
    expect(body().temperature).toBe(0.6);
    expect(body().top_p).toBeUndefined();
  });

  it('does not invent sampling support from caller overrides', async () => {
    await provide(context(apiType, { temperature: 0.4, top_p: 0.7 }, {
      thinking: true, openai: { sampling: false }, claude: { thinkingMode: 'adaptive', sampling: false },
    }));
    expect(body().temperature).toBeUndefined();
    expect(body().top_p).toBeUndefined();
  });

  it('uses explicit direct API reasoning over canonicalized host defaults', async () => {
    const request = context(apiType, {}, { thinking: true,
      openai: { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
      claude: { thinkingMode: 'adaptive', reasoningEfforts: ['low', 'high'] },
    });
    request.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto,
      modelOptions: { reasoningEffort: 'high' }, modelConfiguration: { reasoningEffort: 'low' },
    } as never);
    await provide(request);
    if (apiType === 'messages') expect(body().output_config).toEqual({ effort: 'high' });
    else if (apiType === 'responses') expect(body().reasoning).toMatchObject({ effort: 'high' });
    else expect(body().reasoning_effort).toBe('high');
  });
});

describe.each(openAIProviders)('%s capability constraints', (apiType, provide, limitField) => {
  it.each([undefined, -1, 0, 1.2, NaN, Infinity, '64'])('does not force a token field for invalid or absent max_tokens=%s', async value => {
    await provide(context(apiType, { max_tokens: value }));
    expect(body()[limitField]).toBeUndefined();
  });

  it('does not send an unsupported token field even for an explicit limit', async () => {
    await provide(context(apiType, { max_tokens: 64 }, { openai: { tokenLimitField: 'omit' } }));
    expect(body()[limitField]).toBeUndefined();
    expect(body().max_completion_tokens).toBeUndefined();
  });

  it('keeps the legacy image token-limit omission policy', async () => {
    const request = context(apiType, { max_tokens: 64 }, { imageInput: true, openai: { imageCompatibility: 'legacy-relay' } });
    request.messages = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.User, name: undefined,
      content: [new vscode.LanguageModelTextPart('image'), new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    }]);
    await provide(request);
    expect(body()[limitField]).toBeUndefined();
  });

  it.each(['low', 'high'])('preserves effort-specific sampling capabilities for %s', async effort => {
    await provide(context(apiType, { reasoningEffort: effort, temperature: 0.3 }, { thinking: true,
      openai: { reasoningEfforts: ['low', 'high'], sampling: true, samplingEfforts: ['low'] },
    }));
    expect(body().temperature).toBe(effort === 'low' ? 0.3 : undefined);
  });
});

describe('protocol-specific request options', () => {
  it('uses max_completion_tokens when declared for Chat Completions', async () => {
    await provideOpenAIResponse(context('chat-completions', { max_tokens: 128 }, { openai: { tokenLimitField: 'max_completion_tokens' } }));
    expect(body().max_completion_tokens).toBe(128);
    expect(body().max_tokens).toBeUndefined();
  });

  it('uses the configured budget when no current model budget exists', () => {
    expect(getConfiguredMaxOutputTokens(undefined, 2000, { modelOptions: { max_tokens: 3000 } } as never)).toBe(2000);
    expect(getConfiguredMaxOutputTokens(undefined, 2000, { modelOptions: { max_tokens: 12 } } as never)).toBe(12);
  });

  it.each([1024, 3000])('bounds Claude manual thinking by the reduced %s output budget', async maxTokens => {
    await provideClaudeResponse(context('messages', { max_tokens: maxTokens, reasoningEffort: 'high', temperature: 0.2 }, {
      thinking: true, claude: { thinkingMode: 'manual', sampling: true },
    }));
    expect(body().max_tokens).toBe(maxTokens);
    expect(body().thinking).toEqual(maxTokens === 1024 ? undefined : { type: 'enabled', budget_tokens: 1976 });
    expect(body().temperature).toBe(maxTokens === 1024 ? 0.2 : undefined);
  });

  it('retains the Claude temperature clamp', async () => {
    await provideClaudeResponse(context('messages', { temperature: 1.8 }, { claude: { sampling: true } }));
    expect(body().temperature).toBe(1);
  });

  it.each(['2026-10-21', '2026-11-01'])('omits Claude sampling with API version %s', async version => {
    settings.anthropicVersion = version;
    await provideClaudeResponse(context('messages', { top_p: 0.4 }, { claude: { sampling: true } }));
    expect(body().top_p).toBeUndefined();
    expect(body().temperature).toBeUndefined();
  });
});
