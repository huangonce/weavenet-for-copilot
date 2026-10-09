import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as vscode from 'vscode';
import { LanguageModelThinkingPart } from '../support/vscode.mock';
import { getConfig } from '../../src/config/config';
import type { ApiType, ConfiguredModel } from '../../src/config/config';
import { snapshotChatRequest, snapshotChatResponseOptions } from '../../src/copilot/canonicalRequest';
import { convertClaudeMessages, convertMessages, convertResponsesInput } from '../../src/copilot/convert';
import { provideClaudeResponse } from '../../src/copilot/claudeResponse';
import { provideOpenAIResponse, provideResponsesResponse } from '../../src/copilot/openaiResponse';
import { fromConfiguredModel, toChatInformation } from '../../src/relay/models';
import { ResponsesReplayCollector } from '../../src/relay/responsesReplay';
import { PROTOCOL_REPLAY_METADATA_KEY } from '../../src/relay/replayState';
import type { ProtocolReplayState } from '../../src/relay/replayState';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Test', baseUrl: 'https://relay.example.test/v1' };
const ping = { name: 'ping', description: 'Test tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
function user(...content: unknown[]) { return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined }; }
function assistant(...content: unknown[]) { return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined }; }
function text(value: string) { return new vscode.LanguageModelTextPart(value); }
function toolResult(id = 'call_1') { return new vscode.LanguageModelToolResultPart(id, [text('tool result')]); }
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function sse(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
function context(apiType: ApiType, model: Partial<ConfiguredModel> = {}, identity = A) {
  const config = getConfig({ ...profile, apiType });
  const routedModel = fromConfiguredModel({ id: 'model', apiType, toolCalling: true, thinking: true, ...model });
  const parts: vscode.LanguageModelResponsePart[] = [];
  return { config, routedModel, protocolIdentity: identity, model: toChatInformation(routedModel, config, true),
    messages: snapshotChatRequest([user(text('first question'))] as never),
    options: snapshotChatResponseOptions({ tools: [ping], toolMode: vscode.LanguageModelChatToolMode.Auto }),
    progress: { report(part: vscode.LanguageModelResponsePart) { parts.push(part); } },
    token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken,
    apiKey: 'synthetic-key', debug: vi.fn(), parts };
}
function state(parts: readonly vscode.LanguageModelResponsePart[]): ProtocolReplayState {
  const values = parts as unknown as Array<{ metadata?: Record<string, unknown> }>;
  const part = values.find(part => part.metadata?.[PROTOCOL_REPLAY_METADATA_KEY]);
  if (!part) throw new Error('Expected complete replay state');
  return part.metadata![PROTOCOL_REPLAY_METADATA_KEY] as ProtocolReplayState;
}
function request(fetch: MockInstance<typeof globalThis.fetch>, index: number): ReturnType<typeof JSON.parse> {
  return JSON.parse(String(fetch.mock.calls[index][1]?.body));
}

beforeEach(() => {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: (key: string) => key === 'claudePromptCaching' ? 'disabled' : undefined } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('Claude signed thinking round trips', () => {
  const blocks = [
    { type: 'thinking', thinking: ' Exact\nthought ', signature: 'SIG-A==\n' },
    { type: 'redacted_thinking', data: 'REDACTED_OPAQUE_A' },
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'call_1', name: 'ping', input: { q: 'docs' } },
  ];
  it('preserves signed and redacted blocks exactly through full response, host history and the second request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ content: blocks, stop_reason: 'tool_use' }))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }));
    const first = context('messages');
    await provideClaudeResponse(first);
    expect(state(first.parts).claude).toEqual(blocks);
    const metadataIndex = first.parts.findIndex(part => !!(part as unknown as { metadata?: Record<string, unknown> }).metadata?.[PROTOCOL_REPLAY_METADATA_KEY]);
    const toolIndex = first.parts.findIndex(part => part instanceof vscode.LanguageModelToolCallPart);
    expect(metadataIndex).toBeLessThan(toolIndex);
    const second = context('messages');
    second.messages = snapshotChatRequest([user(text('first question')), assistant(...first.parts), user(toolResult())] as never);
    await provideClaudeResponse(second);
    expect(request(fetch, 1).messages[1]).toEqual({ role: 'assistant', content: blocks });
    expect(request(fetch, 1).messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(JSON.stringify(first.debug.mock.calls)).not.toContain('SIG-A');
    expect(JSON.stringify(first.debug.mock.calls)).not.toContain('REDACTED_OPAQUE');
  });

  it('joins signature_delta fragments and preserves the original content block order', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' Exact\nthought ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'A==\n' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: blocks[1] },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_1', name: 'ping', input: {} } },
      { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"q":"docs"}' } },
      { type: 'content_block_stop', index: 3 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]));
    const current = context('messages');
    await provideClaudeResponse(current);
    expect(state(current.parts).claude).toEqual(blocks);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not publish a tool or state if the signed thinking block is incomplete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'partial' } },
      { type: 'content_block_start', index: 1, content_block: blocks[3] },
      { type: 'content_block_stop', index: 1 },
    ]));
    const current = context('messages');
    await expect(provideClaudeResponse(current)).rejects.toThrow();
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(current.parts.some(part => !!(part as unknown as { metadata?: unknown }).metadata)).toBe(false);
  });

  it('does not execute completed-looking tools when the model ends at max_tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ content: blocks, stop_reason: 'max_tokens' }));
    const current = context('messages');
    await provideClaudeResponse(current);
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(state(current.parts).claude).toEqual([{ type: 'text', text: 'Checking.' }]);
  });

  it('rejects signed tool history from a different model or credential identity', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ content: blocks, stop_reason: 'tool_use' }));
    const first = context('messages');
    await provideClaudeResponse(first);
    const second = context('messages', {}, B);
    second.messages = snapshotChatRequest([assistant(...first.parts), user(toolResult())] as never);
    await expect(provideClaudeResponse(second)).rejects.toThrow(/different|matching signed state/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects changes to visible history instead of silently replaying stale content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ content: blocks, stop_reason: 'tool_use' }));
    const first = context('messages');
    await provideClaudeResponse(first);
    const altered = first.parts.map(part => part instanceof vscode.LanguageModelTextPart ? text('edited') : part);
    const snapshot = snapshotChatRequest([assistant(...altered), user(toolResult())] as never);
    expect(() => convertClaudeMessages(snapshot, { supportsImageInput: false, protocolIdentity: A })).toThrow('no longer matches');
  });

  it('sends adaptive + output_config.effort without budget_tokens', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ content: [{ type: 'text', text: 'answer' }] }));
    const current = context('messages', { claude: { thinkingMode: 'adaptive', reasoningEfforts: ['low', 'high'] } });
    current.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: 'low' } });
    await provideClaudeResponse(current);
    expect(request(fetch, 0)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(request(fetch, 0).thinking).not.toHaveProperty('budget_tokens');
  });
});

describe('DeepSeek Chat reasoning history', () => {
  it('replays every assistant turn, including a plain-text turn before tools were present', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'answer one', reasoning_content: 'THOUGHT_ONE' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '', reasoning_content: 'THOUGHT_TWO', tool_calls: [{
        id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"q":"docs"}' },
      }] }, finish_reason: 'tool_calls' }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'done', reasoning_content: 'THOUGHT_THREE' }, finish_reason: 'stop' }] }));
    const first = context('chat-completions', { openai: { replayReasoningContent: true } });
    first.options = snapshotChatResponseOptions({ toolMode: vscode.LanguageModelChatToolMode.Auto });
    await provideOpenAIResponse(first);
    const history = [user(text('one')), assistant(...first.parts), user(text('two'))];
    const second = context('chat-completions', { openai: { replayReasoningContent: true } });
    second.messages = snapshotChatRequest(history as never);
    await provideOpenAIResponse(second);
    expect(request(fetch, 1).messages[1]).toMatchObject({ role: 'assistant', content: 'answer one', reasoning_content: 'THOUGHT_ONE' });
    const third = context('chat-completions', { openai: { replayReasoningContent: true } });
    third.messages = snapshotChatRequest([...history, assistant(...second.parts), user(toolResult())] as never);
    await provideOpenAIResponse(third);
    expect(request(fetch, 2).messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { reasoning_content: string }) => message.reasoning_content))
      .toEqual(['THOUGHT_ONE', 'THOUGHT_TWO']);
  });
  it('keeps reasoning_content out of normal Chat requests without the explicit capability', () => {
    const messages = snapshotChatRequest([assistant(new LanguageModelThinkingPart('old thought'), text('answer'))] as never);
    expect(convertMessages(messages, false)[0]).not.toHaveProperty('reasoning_content');
    expect(convertMessages(messages, false, false, true)[0].reasoning_content).toBe('old thought');
  });
});

describe('Responses phase and message boundaries', () => {
  const output = [
    { id: 'm1', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'first' }] },
    { id: 'm2', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: ' second' }] },
    { id: 'fc1', type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{"q":"docs"}', status: 'completed' },
  ];
  it('preserves a pure-text commentary message and two separate messages in the second request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ status: 'completed', output }))
      .mockResolvedValueOnce(json({ status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done' }] }] }));
    const first = context('responses');
    await provideResponsesResponse(first);
    const second = context('responses');
    second.messages = snapshotChatRequest([user(text('question')), assistant(...first.parts), user(toolResult())] as never);
    await provideResponsesResponse(second);
    expect(request(fetch, 1).input.slice(1, 4)).toEqual(output);
  });
  it('uses the phase from added when done/terminal omit it, and never invents a phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', phase: 'commentary', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    const current = context('responses');
    await provideResponsesResponse(current);
    expect(state(current.parts).responses?.[0]).toMatchObject({ phase: 'commentary' });
    const snapshot = snapshotChatRequest([assistant(text('no phase'))] as never);
    expect(convertResponsesInput(snapshot, false, false, true).input[0]).not.toHaveProperty('phase');
  });
  it('retains reasoning delta through empty done and terminal reasoning items', () => {
    const collector = new ResponsesReplayCollector();
    collector.consume({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs', summary: [] } });
    collector.consume({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'FULL_REASONING' });
    collector.consume({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs', summary: [] } });
    collector.consume({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{}' } });
    const items = collector.finish([{ type: 'reasoning', id: 'rs', summary: [] }, { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{}' }]);
    const replay: ProtocolReplayState = { version: 1, apiType: 'responses', identity: A, displayText: '', responses: items };
    const snapshot = snapshotChatRequest([assistant(new LanguageModelThinkingPart('', undefined, { [PROTOCOL_REPLAY_METADATA_KEY]: replay }), new vscode.LanguageModelToolCallPart('call_1', 'ping', {}))] as never);
    expect(convertResponsesInput(snapshot, false, true, true, false, A).input[0]).toMatchObject({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'FULL_REASONING' }] });
  });
  it('does not replay encrypted state through either a bound or old unbound carrier after identity changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'completed', output: [
      { type: 'reasoning', id: 'rs_A', encrypted_content: 'OPAQUE_A', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ] }));
    const first = context('responses', { openai: { encryptedReasoning: true } });
    await provideResponsesResponse(first);
    const legacy = new LanguageModelThinkingPart('', 'rs_A', { weavenetResponsesReasoning: { encryptedContent: 'OPAQUE_A', summary: [] } });
    const snapshot = snapshotChatRequest([assistant(...first.parts, legacy)] as never);
    expect(JSON.stringify(convertResponsesInput(snapshot, false, false, true, true, B))).not.toContain('OPAQUE_A');
    const oldToolHistory = snapshotChatRequest([assistant(legacy, new vscode.LanguageModelToolCallPart('call_1', 'ping', {}))] as never);
    expect(() => convertResponsesInput(oldToolHistory, false, false, true, true, B)).toThrow('Unbound encrypted');
  });
  it('does not publish tools or encrypted reasoning from an incomplete response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'incomplete', output: [
      { type: 'reasoning', id: 'rs', encrypted_content: 'PARTIAL_OPAQUE', summary: [] }, ...output,
    ] }));
    const current = context('responses', { openai: { encryptedReasoning: true } });
    await provideResponsesResponse(current);
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(JSON.stringify(state(current.parts))).not.toContain('PARTIAL_OPAQUE');
  });
});

describe('protocol state coherence and cancellation', () => {
  it.each(['messages', 'chat-completions', 'responses'] as const)('rejects hidden payload text that does not match visible text for %s', (apiType) => {
    const replay: ProtocolReplayState = { version: 1, identity: A, apiType, displayText: 'VISIBLE',
      ...(apiType === 'messages' ? { claude: [{ type: 'text' as const, text: 'HIDDEN' }] } : {}),
      ...(apiType === 'chat-completions' ? { chat: { role: 'assistant' as const, content: 'HIDDEN', reasoning_content: 'reason' } } : {}),
      ...(apiType === 'responses' ? { responses: [{ type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'HIDDEN' }] }] } : {}),
    };
    const snapshot = snapshotChatRequest([assistant(text('VISIBLE'), new LanguageModelThinkingPart('', undefined, { [PROTOCOL_REPLAY_METADATA_KEY]: replay }))] as never);
    const convert = () => apiType === 'messages' ? convertClaudeMessages(snapshot, { supportsImageInput: false, protocolIdentity: A })
      : apiType === 'chat-completions' ? convertMessages(snapshot, false, false, true, A) : convertResponsesInput(snapshot, false, false, true, false, A);
    expect(convert).toThrow('no longer matches');
  });

  it('rejects conflicting completed text before publishing any pending tool', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', phase: 'commentary', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'VISIBLE' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'HIDDEN' }] } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{}' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    const current = context('responses');
    await expect(provideResponsesResponse(current)).rejects.toThrow();
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(current.parts.some(part => !!(part as unknown as { metadata?: unknown }).metadata)).toBe(false);
  });

  it('rejects duplicate tool IDs before publishing a batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'completed', output: [
      { type: 'function_call', call_id: 'dup', name: 'ping', arguments: '{}' },
      { type: 'function_call', call_id: 'dup', name: 'ping', arguments: '{}' },
    ] }));
    const current = context('responses');
    await expect(provideResponsesResponse(current)).rejects.toThrow();
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
  });

  it('enforces the metadata state bound before tools are released', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ choices: [{ message: {
      content: 'x'.repeat(4 * 1024 * 1024 + 1), reasoning_content: 'reason',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
    }, finish_reason: 'tool_calls' }] }));
    const current = context('chat-completions', { openai: { replayReasoningContent: true } });
    await expect(provideOpenAIResponse(current)).rejects.toThrow();
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(current.parts.some(part => !!(part as unknown as { metadata?: unknown }).metadata)).toBe(false);
  });

  it('does not store state or publish pending tools after cancellation', async () => {
    const source = new vscode.CancellationTokenSource();
    const current = context('responses');
    current.token = source.token;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      source.cancel();
      return json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{}' }] });
    });
    await expect(provideResponsesResponse(current)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(current.parts.some(part => part instanceof vscode.LanguageModelToolCallPart)).toBe(false);
    expect(current.parts.some(part => !!(part as unknown as { metadata?: unknown }).metadata)).toBe(false);
  });
});
