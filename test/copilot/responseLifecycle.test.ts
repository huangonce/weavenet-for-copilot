import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import type { ApiType } from '../../src/config/config';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import type { DebugLogger } from '../../src/copilot/requestDiagnostics';
import { runResponseLifecycle } from '../../src/copilot/responseLifecycle';
import { RelayClient } from '../../src/relay/client';
import { RelayRequestError } from '../../src/relay/errors';
import { fromConfiguredModel, toChatInformation } from '../../src/relay/models';
import type { StreamCallbacks } from '../../src/relay/types';

const variants = [
  { apiType: 'chat-completions', protocol: 'OpenAI', method: 'streamChatCompletion', provide: provideOpenAIResponse },
  { apiType: 'responses', protocol: 'Responses', method: 'streamResponses', provide: provideResponsesResponse },
  { apiType: 'messages', protocol: 'Claude', method: 'streamClaudeMessages', provide: provideClaudeResponse },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('honors cancellation between protocol completion and final output flushing', async () => {
  const current = context('chat-completions');
  const result = runResponseLifecycle(current, 'OpenAI', 1, 0, async (output) => {
    output.text('pending answer');
    // This runs after the operation returns but before its awaiting caller resumes.
    void Promise.resolve().then(() => current.source.cancel());
  });

  await expect(result).rejects.toBeInstanceOf(vscode.CancellationError);
  vi.runAllTimers();

  expect(current.parts).toEqual([]);
  expect(settlements(current)).toEqual([expect.stringContaining('OpenAI request cancelled:')]);
  expect(vi.getTimerCount()).toBe(0);
});

describe.each(variants)('$apiType response lifecycle', ({ apiType, protocol, method, provide }) => {
  it.each(['completed', 'failed', 'cancelled'] as const)('includes cumulative usage once when %s', async outcome => {
    const current = context(apiType);
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      callbacks.onContent('private answer');
      if (apiType === 'messages') {
        callbacks.onClaudeUsage?.({ input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 20,
          cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 }, output_tokens: 1 });
        callbacks.onClaudeUsage?.({ output_tokens: 5 });
        callbacks.onClaudeUsage?.({ output_tokens: 7 });
      } else {
        callbacks.onOpenAIUsage?.({ prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 } });
        callbacks.onOpenAIUsage?.({ completion_tokens: 5 });
        callbacks.onOpenAIUsage?.({ completion_tokens: 7 });
      }
      if (outcome === 'cancelled') current.source.cancel();
      if (outcome === 'failed') throw new Error('private transport detail');
      emitNativeText(callbacks, 'private answer');
    });
    if (outcome === 'completed') await provide(current);
    else await expect(provide(current)).rejects.toBeInstanceOf(Error);
    expect(settlements(current)).toHaveLength(1);
    expect(settlements(current)[0]).toContain(`${protocol} request ${outcome}:`);
    expect(settlements(current)[0]).toContain('usage={inputTotal:120,output:7,total:127,cacheRead:60,cacheWrite:20');
    const logs = current.debug.mock.calls.map(([, message]) => message).join('\n');
    expect(logs).not.toContain('private answer');
    expect(logs).not.toContain('private transport detail');
  });

  it('publishes validated tools after their text and records successful completion', async () => {
    const current = context(apiType);
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      emitPendingResponse(callbacks);
      expect(current.parts).toEqual([]);
    });

    await provide(current);

    expect(current.parts[0]).toMatchObject({ value: 'partial answer' });
    expect(current.parts.at(-1)).toMatchObject({ callId: 'call-1', name: 'search', input: { q: 'docs' } });
    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request completed:`)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps partial text but withholds pending tools when the transport fails', async () => {
    const current = context(apiType);
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      emitPendingResponse(callbacks);
      throw new RelayRequestError('private upstream detail', 429, 'json');
    });

    await expect(provide(current)).rejects.toMatchObject({ code: 'Blocked' });

    expect(current.parts).toEqual([new vscode.LanguageModelTextPart('partial answer')]);
    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request failed:`)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('discards buffered output after cancellation, transport rejects=%s', async (rejectTransport) => {
    const current = context(apiType);
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      emitPendingResponse(callbacks);
      current.source.cancel();
      if (rejectTransport) throw new Error('transport aborted');
    });

    await expect(provide(current)).rejects.toBeInstanceOf(vscode.CancellationError);
    vi.runAllTimers();

    expect(current.parts).toEqual([]);
    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request cancelled:`)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the transport error when reporting the remaining text also fails', async () => {
    const current = context(apiType);
    const transportError = new Error('transport failed');
    current.progress.report = () => { throw new Error('progress closed'); };
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      callbacks.onContent('partial answer');
      throw transportError;
    });

    await expect(provide(current)).rejects.toBe(transportError);

    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request failed:`)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces progress failures before recording successful completion', async () => {
    const current = context(apiType);
    const progressError = new Error('progress closed');
    current.progress.report = () => { throw progressError; };
    vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      callbacks.onContent('answer');
      emitNativeText(callbacks, 'answer');
    });

    await expect(provide(current)).rejects.toBe(progressError);

    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request failed:`)]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(variants.filter(variant => variant.apiType !== 'chat-completions'))('$apiType replay completion contract', ({ apiType, protocol, method, provide }) => {
  it('does not reconstruct or publish tools when a successful transport omits its replay payload', async () => {
    const current = context(apiType);
    const stream = vi.spyOn(RelayClient.prototype, method).mockImplementation(async (_request: unknown, callbacks: StreamCallbacks) => {
      callbacks.onContent('partial answer');
      callbacks.onClaudeStopReason?.('tool_use');
      callbacks.onToolCall({ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } });
    });

    await expect(provide(current)).rejects.toThrow('without its protocol replay payload');

    expect(current.parts).toEqual([new vscode.LanguageModelTextPart('partial answer')]);
    expect(settlements(current)).toEqual([expect.stringContaining(`${protocol} request failed:`)]);
    expect(stream).toHaveBeenCalledOnce();
  });
});

function emitPendingResponse(callbacks: StreamCallbacks): void {
  callbacks.onClaudeStopReason?.('tool_use');
  callbacks.onContent('partial ');
  callbacks.onContent('answer');
  callbacks.onResponsesOutputItems?.([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial answer' }] },
    { type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{"q":"docs"}' },
  ]);
  callbacks.onClaudeAssistantContent?.([
    { type: 'text', text: 'partial answer' }, { type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'docs' } },
  ]);
  callbacks.onToolCall({ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"docs"}' } });
}

function emitNativeText(callbacks: StreamCallbacks, text: string): void {
  callbacks.onResponsesOutputItems?.([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
  callbacks.onClaudeStopReason?.('end_turn');
  callbacks.onClaudeAssistantContent?.([{ type: 'text', text }]);
}

function context(apiType: ApiType) {
  const config = getConfig({ id: '11111111-1111-4111-8111-111111111111', name: 'Test', baseUrl: 'https://relay.example.test/v1', apiType });
  const routedModel = fromConfiguredModel({ id: 'model', apiType, toolCalling: true, thinking: false,
    openai: { replayReasoningContent: true } });
  const parts: vscode.LanguageModelResponsePart[] = [];
  const source = new vscode.CancellationTokenSource();
  return {
    config, routedModel, model: toChatInformation(routedModel, config, true),
    messages: snapshotChatRequest([vscode.LanguageModelChatMessage.User('hello')]),
    options: snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto,
      tools: [{ name: 'search', description: 'Search documents', inputSchema: { type: 'object' } }] }),
    progress: { report(part: vscode.LanguageModelResponsePart) { parts.push(part); } },
    token: source.token, apiKey: 'test-key', protocolIdentity: 'a'.repeat(64), debug: vi.fn<DebugLogger>(), parts, source,
  };
}

function settlements(current: ReturnType<typeof context>): string[] {
  return current.debug.mock.calls.map(([, message]) => message)
    .filter(message => /request (completed|cancelled|failed):/.test(message));
}
