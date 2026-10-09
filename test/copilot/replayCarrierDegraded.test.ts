import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The host carrier for protocol state (the thinking part class) is a proposed API
 * surface, so a host may not expose it. These tests run against a host mock
 * without it and prove the extension degrades explicitly instead of failing the
 * whole request.
 */
vi.mock('vscode', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../test/support/vscode.mock');
  const { LanguageModelThinkingPart: omitted, ...rest } = actual;
  void omitted;
  return rest;
});

import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import { hasProtocolReplayCarrier, warnProtocolReplayUnavailable } from '../../src/copilot/protocolState';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { RelayClient } from '../../src/relay/client';
import { PROTOCOL_REPLAY_METADATA_KEY } from '../../src/relay/replayState';
import { toChatInformation, toRoutedModel } from '../../src/relay/models';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = 'a'.repeat(64);

function configFixture(apiType: 'messages' | 'chat-completions') {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: () => undefined,
    inspect: () => undefined,
  } as never);
  return {
    ...getConfig({ id: PROFILE_ID, name: 'Smoke', baseUrl: 'https://relay.example.test/v1', apiType }),
    supportsToolCalling: true,
  };
}

function requestContext(apiType: 'messages' | 'chat-completions') {
  const config = configFixture(apiType);
  const routedModel = apiType === 'messages'
    ? toRoutedModel({ id: 'claude-smoke', context_length: 200_000, max_completion_tokens: 8_192, capabilities: {
      tool_calling: true, reasoning: true, claude: { thinkingMode: 'manual', sampling: true, forcedToolChoice: true },
    } }, 'messages')
    : toRoutedModel({ id: 'gpt-smoke', context_length: 128_000, max_completion_tokens: 4_096, capabilities: {
      tool_calling: true, openai: { replayReasoningContent: true },
    } }, 'chat-completions');
  return {
    config,
    routedModel,
    model: toChatInformation(routedModel, config, true),
    messages: snapshotChatRequest([{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('hello')],
      name: undefined,
    }]),
    options: snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto } as never),
    progress: { report: vi.fn() } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
    token: new vscode.CancellationTokenSource().token,
    apiKey: 'test-key',
    protocolIdentity: IDENTITY,
    debug: () => undefined,
  };
}

function reportedParts(context: { progress: { report: unknown } }): unknown[] {
  return (context.progress.report as { mock: { calls: unknown[][] } }).mock.calls.map(([part]) => part);
}

function carriesReplayState(part: unknown): boolean {
  const metadata = (part as { metadata?: Record<string, unknown> }).metadata;
  return metadata?.[PROTOCOL_REPLAY_METADATA_KEY] !== undefined;
}

afterEach(() => vi.restoreAllMocks());

describe('hosts without a protocol replay carrier', () => {
  it('reports a missing carrier at most once instead of treating it as a failure', () => {
    expect(hasProtocolReplayCarrier()).toBe(false);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');

    warnProtocolReplayUnavailable('Claude');
    warnProtocolReplayUnavailable('OpenAI');
    warnProtocolReplayUnavailable('Responses');

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes('cannot carry'))).toHaveLength(1);
  });

  it('disables native Claude thinking and skips the replay state', async () => {
    const context = requestContext('messages');
    let request: { thinking?: unknown } | undefined;
    vi.spyOn(RelayClient.prototype, 'streamClaudeMessages').mockImplementation(async (sent, callbacks) => {
      request = sent as { thinking?: unknown };
      callbacks.onReasoning('private thought');
      callbacks.onContent('answer');
      callbacks.onClaudeAssistantContent?.([{ type: 'thinking', thinking: 'private thought', signature: 'sig' }, { type: 'text', text: 'answer' }]);
      callbacks.onClaudeStopReason?.('end_turn');
    });

    await provideClaudeResponse(context as never);

    expect(request?.thinking).toBeUndefined();
    const parts = reportedParts(context);
    expect(parts.some((part) => (part as { value?: string }).value === 'answer')).toBe(true);
    expect(parts.filter(carriesReplayState)).toEqual([]);
  });

  it('publishes buffered Chat tool calls instead of waiting for an impossible replay', async () => {
    const context = requestContext('chat-completions');
    vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (_request, callbacks) => {
      callbacks.onReasoning('private reasoning');
      callbacks.onContent('answer');
      callbacks.onToolCall({ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"docs"}' } });
      callbacks.onOpenAIFinishReason?.('tool_calls');
    });

    await provideOpenAIResponse(context as never);

    const parts = reportedParts(context);
    expect(parts.filter(carriesReplayState)).toEqual([]);
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'answer' }),
      expect.objectContaining({ callId: 'call-1', name: 'search', input: { q: 'docs' } }),
    ]));
  });

  it('keeps the Responses request stateless and unparsed when the carrier is missing', async () => {
    const config = configFixture('chat-completions');
    const routedModel = toRoutedModel({ id: 'gpt-smoke', context_length: 128_000, max_completion_tokens: 4_096, capabilities: {
      tool_calling: true, openai: { replayReasoningContent: true, encryptedReasoning: true },
    } }, 'responses');
    const context = {
      ...requestContext('chat-completions'),
      config,
      routedModel,
      model: toChatInformation(routedModel, config, true),
    };
    vi.spyOn(RelayClient.prototype, 'streamResponses').mockImplementation(async (_request, callbacks) => {
      callbacks.onReasoning('private reasoning');
      callbacks.onContent('answer');
      callbacks.onResponsesOutputItems?.([
        { type: 'reasoning', id: 'rs-1', summary: [], content: [{ type: 'reasoning_text', text: 'private reasoning' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      ] as never);
    });

    await provideResponsesResponse(context as never);

    const parts = reportedParts(context);
    expect(parts.filter(carriesReplayState)).toEqual([]);
    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'answer' })]));
  });
});
