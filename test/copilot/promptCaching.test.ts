import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import type { ApiType, ConfiguredModel } from '../../src/config/config';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { claudePrefix } from '../../src/copilot/claudePrefix';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import { fromConfiguredModel, toChatInformation } from '../../src/relay/models';

const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Test', baseUrl: 'https://relay.example.test/v1' };
const tool = { name: 'search', description: 'Search documents', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const system = () => ({ role: 3, content: [text('Follow the instructions.')], name: undefined });
let settings: Record<string, unknown>;

beforeEach(() => {
  settings = { modelMetadataEnabled: false, debug: true, claudePromptCaching: 'automatic' };
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({ get: (key: string) => settings[key] }) as never);
});
afterEach(() => vi.restoreAllMocks());

function context(apiType: ApiType, overrides: Partial<ConfiguredModel> = {}) {
  const config = getConfig({ ...profile, apiType });
  const routedModel = fromConfiguredModel({ id: 'model', apiType, thinking: false, toolCalling: true, ...overrides });
  const parts: vscode.LanguageModelResponsePart[] = [];
  return { config, routedModel, model: toChatInformation(routedModel, config, true),
    messages: snapshotChatRequest([system(), vscode.LanguageModelChatMessage.User('first'),
      vscode.LanguageModelChatMessage.Assistant('previous answer'), vscode.LanguageModelChatMessage.User('second')] as never),
    options: snapshotChatResponseOptions({ tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto }),
    progress: { report: (part: vscode.LanguageModelResponsePart) => { parts.push(part); } },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken,
    apiKey: 'synthetic', protocolIdentity: 'a'.repeat(64), debug: vi.fn(), parts,
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function body(fetch: MockInstance<typeof globalThis.fetch>, index = 0) {
  return JSON.parse(String(fetch.mock.calls[index][1]?.body));
}

function countCacheMarkers(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((total, [key, nested]) => total + Number(key === 'cache_control') + countCacheMarkers(nested), 0);
}

describe('Claude prompt caching policy', () => {
  it.each(['5m', '1h'] as const)('uses only the top-level %s marker when automatic caching is declared', async ttl => {
    settings.claudePromptCachingTTL = ttl;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ content: [{ type: 'text', text: 'answer' }] }));
    await provideClaudeResponse(context('messages', { claude: { automaticCaching: true } }));
    const request = body(fetch);
    expect(request.cache_control).toEqual(ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
    expect(countCacheMarkers(request)).toBe(1);
    expect(request.system).toEqual([{ type: 'text', text: 'Follow the instructions.' }]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([undefined, false])('keeps the four explicit breakpoints for automatic capability %s', async automaticCaching => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ content: [{ type: 'text', text: 'answer' }] }));
    await provideClaudeResponse(context('messages', { claude: { automaticCaching } }));
    const request = body(fetch);
    expect(request.cache_control).toBeUndefined();
    expect(countCacheMarkers(request)).toBe(4);
    expect(request.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it.each([undefined, false, true])('omits all markers when caching is disabled, capability=%s', async automaticCaching => {
    settings.claudePromptCaching = 'disabled';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ content: [{ type: 'text', text: 'answer' }] }));
    await provideClaudeResponse(context('messages', { claude: { automaticCaching } }));
    expect(countCacheMarkers(body(fetch))).toBe(0);
  });

  it.each([
    { label: 'explicit to automatic', fromEnabled: true, fromAutomatic: false, toEnabled: true, toAutomatic: true },
    { label: 'automatic to disabled', fromEnabled: true, fromAutomatic: true, toEnabled: false, toAutomatic: true },
    { label: 'disabled to automatic', fromEnabled: false, fromAutomatic: true, toEnabled: true, toAutomatic: true },
    { label: 'explicit to disabled', fromEnabled: true, fromAutomatic: false, toEnabled: false, toAutomatic: false },
    { label: 'disabled to explicit', fromEnabled: false, fromAutomatic: false, toEnabled: true, toAutomatic: false },
  ])('preserves signed thinking and the prefix hash when changing $label', async ({ fromEnabled, fromAutomatic, toEnabled, toAutomatic }) => {
    const signed = [
      { type: 'thinking', thinking: 'original thought', signature: 'opaque-signature' },
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'docs' } },
    ];
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ content: signed, stop_reason: 'tool_use' }))
      .mockResolvedValueOnce(response({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
    settings.claudePromptCaching = fromEnabled ? 'automatic' : 'disabled';
    const first = context('messages', { thinking: true, claude: { thinkingMode: 'manual', automaticCaching: fromAutomatic } });
    first.messages = snapshotChatRequest([system(), vscode.LanguageModelChatMessage.User('first')] as never);
    await provideClaudeResponse(first);
    settings.claudePromptCaching = toEnabled ? 'automatic' : 'disabled';
    const second = context('messages', { thinking: true, claude: { thinkingMode: 'manual', automaticCaching: toAutomatic } });
    second.messages = snapshotChatRequest([system(), vscode.LanguageModelChatMessage.User('first'),
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: first.parts, name: undefined },
      { role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelToolResultPart('call_1', [text('result')])], name: undefined },
    ] as never);
    await provideClaudeResponse(second);
    const firstRequest = body(fetch);
    const secondRequest = body(fetch, 1);
    expect(secondRequest.messages[1].content).toEqual(signed);
    expect(claudePrefix({ ...secondRequest, messages: secondRequest.messages.slice(0, firstRequest.messages.length) }))
      .toEqual(claudePrefix(firstRequest));
    expect(countCacheMarkers(firstRequest)).toBe(!fromEnabled ? 0 : fromAutomatic ? 1 : 3);
    expect(countCacheMarkers(secondRequest)).toBe(!toEnabled ? 0 : toAutomatic ? 1 : 4);
    expect(JSON.stringify(second.debug.mock.calls)).not.toContain('opaque-signature');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe.each([
  ['chat-completions', provideOpenAIResponse], ['responses', provideResponsesResponse],
] as const)('%s prompt cache keys', (apiType, provide) => {
  it.each([
    { label: 'unknown GPT capability', id: 'gpt-looking-name', capability: undefined, key: '', enabled: true, expected: 'omitted' },
    { label: 'declared capability', id: 'relay-model', capability: true, key: '', enabled: true, expected: 'generated' },
    { label: 'explicit user key', id: 'relay-model', capability: undefined, key: 'stable-user-key', enabled: true, expected: 'explicit' },
    { label: 'explicit capability denial', id: 'relay-model', capability: false, key: 'stable-user-key', enabled: true, expected: 'omitted' },
    { label: 'global caching disabled', id: 'relay-model', capability: true, key: 'stable-user-key', enabled: false, expected: 'omitted' },
  ])('respects $label', async ({ id, capability, key, enabled, expected }) => {
    settings.openaiPromptCacheKey = key;
    settings.openaiPromptCaching = enabled;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(apiType === 'responses'
      ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }
      : { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
    const current = context(apiType, { id, openai: { promptCacheKey: capability } });
    await provide(current);
    const request = body(fetch);
    if (expected === 'omitted') expect(request).not.toHaveProperty('prompt_cache_key');
    else if (expected === 'generated') expect(request.prompt_cache_key).toMatch(/^weavenet-/);
    else {
      expect(request.prompt_cache_key).toBe('stable-user-key');
      const next = context(apiType, { id, openai: { promptCacheKey: capability } });
      next.messages = snapshotChatRequest([vscode.LanguageModelChatMessage.User('a different question')]);
      await provide(next);
      expect(body(fetch, 1).prompt_cache_key).toBe(request.prompt_cache_key);
      expect(current.debug.mock.calls.map(([, message]) => message).join('\n')).not.toContain('stable-user-key');
    }
  });
});

it.each(['chat-completions', 'responses', 'messages'] as const)('serializes the %s wire request once even with debug logging enabled', async apiType => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(apiType === 'responses'
    ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }
    : apiType === 'messages' ? { content: [{ type: 'text', text: 'answer' }] }
      : { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
  const current = context(apiType);
  const stringify = vi.spyOn(JSON, 'stringify');
  if (apiType === 'messages') await provideClaudeResponse(current);
  else if (apiType === 'responses') await provideResponsesResponse(current);
  else await provideOpenAIResponse(current);
  const requests = stringify.mock.calls.filter(([value]) => value && typeof value === 'object'
    && 'model' in value && 'stream' in value);
  expect(requests).toHaveLength(1);
  const bytes = Buffer.byteLength(String(fetch.mock.calls[0][1]?.body));
  const transport = current.debug.mock.calls.map(([, message]) => String(message)).filter(message => message.includes('transport started:'));
  expect(transport).toHaveLength(1);
  expect(transport[0]).toContain(`bodyBytes=${bytes}`);
});
