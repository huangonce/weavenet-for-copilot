import { describe, expect, it, vi } from 'vitest';
import {
  processClaudeFullResponse,
  processClaudeSseLine,
  processClaudeStream,
  streamClaudeMessages,
} from '../../src/relay/claude';
import type { StreamCallbacks } from '../../src/relay/client';
import type { ToolCall } from '../../src/relay/types';

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

  it('rejects oversized complete JSON and unbounded SSE events', async () => {
    await expect(processClaudeFullResponse(new Response('{"content":[]}'), callbacks(), 1_000, undefined, 4))
      .rejects.toThrow('exceeds 4 bytes');

    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ value: new TextEncoder().encode('data: 123456'), done: false }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { body: { getReader: () => reader } } as unknown as Response;
    await expect(processClaudeStream(response, callbacks(), 1_000, undefined, 8)).rejects.toThrow('exceeds 8 bytes');
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

describe('Claude stream fallback', () => {
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
