import { describe, expect, it, vi } from 'vitest';
import {
  applyLastTwoUserCacheControl,
  clampClaudeTemperature,
  convertClaudeMessages,
  convertClaudeTools,
  normalizeClaudeImageMediaType,
  processClaudeFullResponse,
  processClaudeSseLine,
  processClaudeStream,
  streamClaudeMessages,
} from '../../src/relay/claude';
import * as vscode from 'vscode';
import type { StreamCallbacks } from '../../src/relay/client';
import type { ClaudeMessage, ToolCall } from '../../src/relay/types';

function callbacks() {
  return {
    onContent: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onProcessingStarted: vi.fn(),
    onClaudeUsage: vi.fn(),
  } satisfies StreamCallbacks;
}

describe('Claude response parsing', () => {
  it('accepts data without a space and recognizes processing and terminal events', () => {
    const cb = callbacks();
    const state = { parts: 0, started: false };
    const tools = new Map<number, ToolCall>();
    processClaudeSseLine('data:{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":2}}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}', tools, cb, state);
    expect(processClaudeSseLine('data: {"type":"message_stop"}', tools, cb, state)).toBe(true);
    expect(cb.onProcessingStarted).toHaveBeenCalledWith('Claude');
    expect(cb.onReasoning).toHaveBeenCalledWith('reason');
    expect(cb.onContent).toHaveBeenCalledWith('answer');
    expect(cb.onClaudeUsage).toHaveBeenCalledOnce();
  });

  it('parses a complete non-stream response with tools', async () => {
    const cb = callbacks();
    await processClaudeFullResponse(new Response(JSON.stringify({
      id: 'msg_1',
      content: [
        { type: 'text', text: 'complete' },
        { type: 'tool_use', id: 'tool_1', name: 'search', input: { q: 'docs' } },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    })), cb);
    expect(cb.onContent).toHaveBeenCalledWith('complete');
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      id: 'tool_1',
      function: { name: 'search', arguments: '{"q":"docs"}' },
    }));
  });

  it('treats content block start and message stop as processing evidence', async () => {
    const response = new Response([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\r\n'), { headers: { 'content-type': 'text/event-stream' } });
    const cb = callbacks();
    await expect(processClaudeStream(response, cb, 1_000)).resolves.toMatchObject({
      terminal: true,
      started: true,
      parts: 0,
    });
    expect(cb.onProcessingStarted).toHaveBeenCalledWith('Claude');
  });

  it('preserves Unicode split across stream chunks and cancels after message_stop', async () => {
    const encoded = new TextEncoder().encode([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n'));
    const split = encoded.findIndex((value, index) => index > 10 && value >= 0x80);
    const chunks = [encoded.slice(0, split + 1), encoded.slice(split + 1)];
    let readIndex = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn(async () => readIndex < chunks.length
        ? { value: chunks[readIndex++], done: false }
        : { value: undefined, done: true }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { body: { getReader: () => reader } } as unknown as Response;
    const cb = callbacks();

    await expect(processClaudeStream(response, cb, 1_000)).resolves.toMatchObject({ terminal: true });
    expect(cb.onContent).toHaveBeenCalledWith('你好');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('prefers streamed tool arguments over a non-empty initial input', () => {
    const cb = callbacks();
    const state = { parts: 0, started: false };
    const tools = new Map<number, ToolCall>();
    processClaudeSseLine('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"search","input":{"stale":true}}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"docs\\"}"}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"content_block_stop","index":0}', tools, cb, state);
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'search', arguments: '{"q":"docs"}' },
    }));
  });

  it('uses initial tool input when no argument delta arrives', () => {
    const cb = callbacks();
    const state = { parts: 0, started: false };
    const tools = new Map<number, ToolCall>();
    processClaudeSseLine('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"search","input":{"q":"docs"}}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"content_block_stop","index":0}', tools, cb, state);
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'search', arguments: '{"q":"docs"}' },
    }));
  });
});

describe('Claude conversion helpers', () => {
  it('allows only Anthropic-supported image MIME types', () => {
    expect(normalizeClaudeImageMediaType('image/jpg')).toBe('image/jpeg');
    expect(normalizeClaudeImageMediaType('image/webp')).toBe('image/webp');
    expect(normalizeClaudeImageMediaType('image/svg+xml')).toBeUndefined();
  });

  it('places cache breakpoints on only the latest two user messages', () => {
    const messages: ClaudeMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ];
    applyLastTwoUserCacheControl(messages, '1h');
    expect((messages[0].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((messages[2].content[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((messages[3].content[0] as { cache_control?: unknown }).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('drops orphan and interrupted Claude tool chains while preserving matched parallel results', () => {
    const assistant = (parts: unknown[]) => ({
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: parts,
    }) as vscode.LanguageModelChatRequestMessage;
    const user = (parts: unknown[]) => ({
      role: vscode.LanguageModelChatMessageRole.User,
      content: parts,
    }) as vscode.LanguageModelChatRequestMessage;
    const converted = convertClaudeMessages([
      user([new vscode.LanguageModelToolResultPart('orphan', [new vscode.LanguageModelTextPart('ignored')])]),
      assistant([
        new vscode.LanguageModelToolCallPart('call_1', 'first', {}),
        new vscode.LanguageModelToolCallPart('call_2', 'second', {}),
      ]),
      user([new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('done')])]),
      user([new vscode.LanguageModelTextPart('continue without second result')]),
    ], { supportsImageInput: false });

    expect(converted.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'first', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
        { type: 'text', text: 'continue without second result' },
      ] },
    ]);
  });

  it('clamps Claude temperature to its supported range', () => {
    expect(clampClaudeTemperature(-0.5)).toBe(0);
    expect(clampClaudeTemperature(0.7)).toBe(0.7);
    expect(clampClaudeTemperature(1.5)).toBe(1);
    expect(clampClaudeTemperature(undefined)).toBeUndefined();
  });

  it('converts system text, images, and cached Claude tools', () => {
    const system = { role: 3, content: [new vscode.LanguageModelTextPart('system rules')] } as never;
    const user = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), 'image/jpg')],
    } as never;
    expect(convertClaudeMessages([system, user], { supportsImageInput: true, promptCaching: true, cacheTTL: '1h' }))
      .toMatchObject({
        system: [{ type: 'text', text: 'system rules', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/jpeg', data: 'AQI=' }, cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
      });
    expect(convertClaudeTools([{ name: 'search', description: 'Search', inputSchema: {} }] as never, true, '1h'))
      .toMatchObject([{ name: 'search', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  });

  it('falls back to a complete response after an empty non-terminal Claude stream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'fallback' }] }), {
        headers: { 'content-type': 'application/json' },
      }));
    const cb = callbacks();
    await streamClaudeMessages({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ stream: false });
    expect(cb.onContent).toHaveBeenCalledWith('fallback');
  });
});
