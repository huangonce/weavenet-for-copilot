import { describe, expect, it, vi } from 'vitest';
import {
  applyLastTwoUserCacheControl,
  normalizeClaudeImageMediaType,
  processClaudeFullResponse,
  processClaudeSseLine,
  processClaudeStream,
} from '../src/relay/claude';
import type { StreamCallbacks } from '../src/relay/client';
import type { ClaudeMessage, ToolCall } from '../src/relay/types';

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
});
