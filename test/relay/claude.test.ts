import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  processClaudeFullResponse,
  processClaudeSseLine,
  processClaudeStream,
  streamClaudeMessages,
} from '../../src/relay/claude';
import type { StreamCallbacks, ToolCall } from '../../src/relay/types';

afterEach(() => vi.restoreAllMocks());

function callbacks() {
  return {
    onContent: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onProcessingStarted: vi.fn(),
    onClaudeUsage: vi.fn(),
    onRequest: vi.fn(),
    onRequestSettled: vi.fn(),
    onResponse: vi.fn(),
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

  it('reports the output-token delta from message_delta exactly once', () => {
    const cb = callbacks();
    const state = { parts: 0, started: false };
    const tools = new Map<number, ToolCall>();
    processClaudeSseLine(
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":3}}',
      tools,
      cb,
      state,
    );
    expect(cb.onClaudeUsage).toHaveBeenCalledOnce();
    expect(cb.onClaudeUsage).toHaveBeenCalledWith({ output_tokens: 3 }, undefined);
  });

  it('never fires the usage callback twice when an event carries both usage shapes', () => {
    const cb = callbacks();
    const state = { parts: 0, started: false };
    const tools = new Map<number, ToolCall>();
    processClaudeSseLine(
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":3},"message":{"id":"msg_1","usage":{"input_tokens":2,"output_tokens":3}}}',
      tools,
      cb,
      state,
    );
    expect(cb.onClaudeUsage).toHaveBeenCalledOnce();
    expect(cb.onClaudeUsage).toHaveBeenCalledWith({ output_tokens: 3 }, 'msg_1');
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
      stop_reason: 'tool_use',
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
    ].join('\r\n') + '\r\n', { headers: { 'content-type': 'text/event-stream' } });
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
    ].join('\n') + '\n');
    const split = encoded.findIndex((value, index) => index > 10 && value >= 0x80);
    const chunks = [encoded.slice(0, split + 1), encoded.slice(split + 1)];
    let readIndex = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn(async () => readIndex < chunks.length
        ? { value: chunks[readIndex++], done: false }
        : { value: undefined, done: true }),
      cancel,
      releaseLock: vi.fn(),
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
      releaseLock: vi.fn(),
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
    expect(cb.onToolCall).not.toHaveBeenCalled();
    processClaudeSseLine('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}', tools, cb, state);
    processClaudeSseLine('data: {"type":"message_stop"}', tools, cb, state);
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
    processClaudeSseLine('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}', tools, cb, state);
    processClaudeSseLine('data: [DONE]', tools, cb, state);
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'search', arguments: '{"q":"docs"}' },
    }));
  });
});

describe('Claude tool completion integrity', () => {
  const start = { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} } };
  const delta = (partial_json: string) => ({ type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json } });
  const stop = { type: 'content_block_stop', index: 0 };
  const reason = (stop_reason: string) => ({ type: 'message_delta', delta: { stop_reason } });
  const response = (events: unknown[]) => new Response(events.map(event =>
    `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));

  it.each(['message_stop', '[DONE]'])('requires an explicit tool_use stop reason before %s publishes tools', async terminal => {
    const cb = callbacks();
    await expect(processClaudeStream(response([start, delta('{}'), stop,
      ...(terminal === '[DONE]' ? ['[DONE]'] : [{ type: terminal }])]), cb, 1_000))
      .rejects.toThrow('without stop_reason=tool_use');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it.each(['end_turn', 'future_stop'])('does not publish tools for stop reason %s', async stopReason => {
    const cb = callbacks();
    await expect(processClaudeStream(response([start, delta('{}'), stop, reason(stopReason), { type: 'message_stop' }]), cb, 1_000))
      .rejects.toThrow('without stop_reason=tool_use');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it('requires content_block_stop even with valid input and tool_use termination', async () => {
    const cb = callbacks();
    await expect(processClaudeStream(response([start, delta('{}'), reason('tool_use'), { type: 'message_stop' }]), cb, 1_000))
      .rejects.toThrow('incomplete content block');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it('does not release a complete tool while an earlier thinking block remains open', async () => {
    const cb = { ...callbacks(), onClaudeAssistantContent: vi.fn() };
    await expect(processClaudeStream(response([
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: 'SIG' } },
      start, delta('{}'), stop, reason('tool_use'), { type: 'message_stop' },
    ]), cb, 1_000)).rejects.toThrow('incomplete content block');
    expect(cb.onToolCall).not.toHaveBeenCalled();
    expect(cb.onClaudeAssistantContent).not.toHaveBeenCalled();
  });

  it.each(['max_tokens', 'model_context_window_exceeded', 'pause_turn'])('discards partial tool JSON and unsigned thinking on %s', async stopReason => {
    const cb = { ...callbacks(), onClaudeAssistantContent: vi.fn() };
    await expect(processClaudeStream(response([
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'partial answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: 'partial thinking' } },
      start, delta('{"q":"unfinished'), stop, reason(stopReason), { type: 'message_stop' },
    ]), cb, 1_000)).resolves.toMatchObject({ terminal: true });
    expect(cb.onToolCall).not.toHaveBeenCalled();
    expect(cb.onClaudeAssistantContent).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'partial answer' }]);
  });

  it.each(['{"secret":"unfinished', '[]', 'null', '1', ''])('rejects invalid completed input without publishing or exposing it: %j', async input => {
    const cb = { ...callbacks(), onClaudeAssistantContent: vi.fn() };
    await expect(processClaudeStream(response([start, delta(input), stop, reason('tool_use'), { type: 'message_stop' }]), cb, 1_000))
      .rejects.toMatchObject({ name: 'RelayStreamError', message: 'Relay Claude stream failed - received invalid tool call arguments' });
    expect(cb.onToolCall).not.toHaveBeenCalled();
    expect(cb.onClaudeAssistantContent).not.toHaveBeenCalled();
  });

  it('validates every call before publishing a batch', async () => {
    const cb = callbacks();
    await expect(processClaudeStream(response([start, delta('{}'), stop,
      { ...start, index: 1, content_block: { ...start.content_block, id: 'call_2', input: [] } },
      { type: 'content_block_stop', index: 1 }, reason('tool_use'), { type: 'message_stop' },
    ]), cb, 1_000)).rejects.toThrow('invalid tool call arguments');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it.each([undefined, 'future_stop', 'end_turn'])('applies the stop reason gate to full JSON: %s', async stop_reason => {
    const cb = callbacks();
    await expect(processClaudeFullResponse(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'partial answer' }, start.content_block], stop_reason,
    })), cb)).rejects.toThrow('without stop_reason=tool_use');
    expect(cb.onContent).toHaveBeenCalledWith('partial answer');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it.each(['max_tokens', 'model_context_window_exceeded', 'pause_turn'])('discards incomplete full JSON tool input on %s', async stop_reason => {
    const cb = { ...callbacks(), onClaudeAssistantContent: vi.fn() };
    await processClaudeFullResponse(new Response(JSON.stringify({ stop_reason,
      content: [{ type: 'text', text: 'partial answer' }, { ...start.content_block, input: '{"q":"unfinished' }],
    })), cb);
    expect(cb.onToolCall).not.toHaveBeenCalled();
    expect(cb.onClaudeAssistantContent).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'partial answer' }]);
  });
});

describe('Claude request completion', () => {
  it.each([undefined, '2023-06-01', '2026-10-21'])('serializes sampling parameters for API version %s', async anthropicVersion => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}', {
      headers: { 'content-type': 'application/json' },
    }));
    const request = { model: 'claude-test', max_tokens: 16, messages: [], stream: true, temperature: 0.4, top_p: 0.6 };
    await streamClaudeMessages({ baseUrl: 'https://relay.example.test/v1', headers: {}, anthropicVersion,
      requestTimeoutMs: 100, streamIdleTimeoutMs: 100 }, request, callbacks());
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    if (anthropicVersion === '2026-10-21') {
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
    } else expect(body).toMatchObject({ temperature: 0.4, top_p: 0.6 });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('anthropic-version')).toBe(anthropicVersion ?? '2023-06-01');
    expect(request).toMatchObject({ temperature: 0.4, top_p: 0.6 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reports one serialized request with a local ID and the native response request-id', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"content":[{"type":"text","text":"answer"}]}', {
      headers: { 'content-type': 'application/json', 'request-id': 'req_native', 'x-request-id': 'req_proxy', 'retry-after': '3' },
    }));
    const request = { model: 'claude-test', max_tokens: 16, stream: true,
      messages: [{ role: 'user' as const, content: 'private prompt 汉😀' }] };
    const stringify = vi.spyOn(JSON, 'stringify');
    const cb = callbacks();
    await streamClaudeMessages({ baseUrl: 'https://relay.example.test/v1', headers: { 'x-api-key': 'private-key' },
      requestTimeoutMs: 100, streamIdleTimeoutMs: 100 }, request, cb);
    expect(stringify.mock.calls.filter(([value]) => value === request)).toHaveLength(1);
    const metadata = cb.onRequest.mock.calls[0][1];
    expect(metadata).toMatchObject({ bodyBytes: Buffer.byteLength(String(fetch.mock.calls[0][1]?.body)),
      clientRequestIdSent: false, attempt: 1, stream: true });
    expect(metadata.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('x-client-request-id')).toBe(false);
    expect(cb.onRequestSettled).toHaveBeenCalledExactlyOnceWith('Claude', {
      clientRequestId: metadata.clientRequestId, responseReceived: true, signalAborted: false,
      abortSource: 'none', tokenCancellationRequested: false,
    });
    expect(cb.onResponse).toHaveBeenCalledExactlyOnceWith('Claude', 200, 'application/json',
      expect.objectContaining({ requestId: 'req_native', clientRequestId: metadata.clientRequestId, retryAfter: '3' }));
    const diagnosticText = JSON.stringify([cb.onRequest.mock.calls, cb.onRequestSettled.mock.calls, cb.onResponse.mock.calls]);
    expect(diagnosticText).not.toContain('private prompt');
    expect(diagnosticText).not.toContain('private-key');
  });

  it('retains the native request-id on an HTTP failure without another POST', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"unavailable"}}', {
      status: 503, headers: { 'content-type': 'application/json', 'request-id': 'req_failed' },
    }));
    const cb = callbacks();
    await expect(streamClaudeMessages({ baseUrl: 'https://relay.example.test/v1', headers: {},
      requestTimeoutMs: 100, streamIdleTimeoutMs: 100 },
    { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb))
      .rejects.toMatchObject({ status: 503, requestId: 'req_failed' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(cb.onResponse).toHaveBeenCalledWith('Claude', 503, 'application/json', expect.objectContaining({ requestId: 'req_failed' }));
  });

  it('reports cancellation before a response arrives without a successful response diagnostic', async () => {
    const source = new vscode.CancellationTokenSource();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const cb = callbacks();
    const result = streamClaudeMessages({ baseUrl: 'https://relay.example.test/v1', headers: {},
      requestTimeoutMs: 100, streamIdleTimeoutMs: 100 },
    { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb, source.token);
    source.cancel();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cb.onRequestSettled).toHaveBeenCalledExactlyOnceWith('Claude', expect.objectContaining({
      responseReceived: false, signalAborted: true, abortSource: 'vscode', tokenCancellationRequested: true,
    }));
    expect(cb.onResponse).not.toHaveBeenCalled();
    source.dispose();
  });

  it.each(['', ': heartbeat\n\n', 'data: {"type":"ping"}\n\n'])(
    'rejects an empty non-terminal stream without repeating the POST: %j', async (body) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
      const cb = { ...callbacks(), onStreamEnd: vi.fn() };

      await expect(streamClaudeMessages({
        baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
      }, { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb))
        .rejects.toThrow('without a response or terminal event');

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ stream: true });
      expect(cb.onContent).not.toHaveBeenCalled();
      expect(cb.onToolCall).not.toHaveBeenCalled();
      expect(cb.onStreamEnd).not.toHaveBeenCalled();
    },
  );

  it('accepts a complete JSON response to the original request without another POST', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'complete' }] }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const cb = callbacks();
    await streamClaudeMessages({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cb.onContent).toHaveBeenCalledWith('complete');
  });

  it('preserves partial text but rejects a missing terminal event without retrying', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const cb = callbacks();
    await expect(streamClaudeMessages({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, cb))
      .rejects.toThrow('before its terminal event');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cb.onContent).toHaveBeenCalledWith('partial');
  });

  it('rejects a terminal-only stream instead of silently completing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n') + '\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect(streamClaudeMessages({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'claude-test', max_tokens: 16, messages: [], stream: true }, callbacks()))
      .rejects.toThrow('without any text, reasoning, or tool calls');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
