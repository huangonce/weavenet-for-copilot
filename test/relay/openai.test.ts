import { afterEach, describe, expect, it, vi } from 'vitest';
import { processOpenAIFullResponse, processOpenAISseLine, processOpenAIStream, streamOpenAIChatCompletion } from '../../src/relay/openai';
import type { ChatRequest, StreamCallbacks, ToolCall } from '../../src/relay/types';

afterEach(() => vi.restoreAllMocks());

function callbacks() {
  return {
    onContent: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onRefusal: vi.fn(),
    onOpenAIFinishReason: vi.fn(),
    onProcessingStarted: vi.fn(),
    onOpenAIUsage: vi.fn(),
  } satisfies StreamCallbacks;
}

function completedStreamResponse(headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'text/event-stream');
  return new Response([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { headers: responseHeaders });
}

describe('OpenAI response parsing', () => {
  it('accepts data without a space and reports reasoning, usage, and terminal finish', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine(
      'data:{"choices":[{"delta":{"reasoning_content":"think","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      tools,
      cb,
      state,
    );
    expect(processOpenAISseLine('data:[DONE]', tools, cb, state)).toBe(true);
    expect(cb.onReasoning).toHaveBeenCalledWith('think');
    expect(cb.onContent).toHaveBeenCalledWith('answer');
    expect(cb.onOpenAIUsage).toHaveBeenCalledOnce();
    expect(cb.onProcessingStarted).toHaveBeenCalledWith('OpenAI');
    expect(cb.onOpenAIFinishReason).toHaveBeenCalledWith('stop');
  });

  it('assembles incremental tool arguments', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs\\"}"}}]},"finish_reason":"tool_calls"}]}',
      tools,
      cb,
      state,
    );
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      id: 'call_1',
      function: { name: 'search', arguments: '{"q":"docs"}' },
    }));
  });

  it('uses the latest complete tool name and serializes object arguments', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"search","arguments":{"q":"docs"}}},{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\\"README.md\\"}"}},{"index":1,"function":{"name":"search"}}]},"finish_reason":"tool_calls"}]}',
      tools,
      cb,
      state,
    );
    expect(cb.onToolCall.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ id: 'call_1', function: { name: 'read', arguments: '{"path":"README.md"}' } }),
      expect.objectContaining({ id: 'call_2', function: { name: 'search', arguments: '{"q":"docs"}' } }),
    ]);
  });

  it('uses repeated or progressively complete tool argument snapshots without duplicating JSON', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
      tools,
      cb,
      state,
    );
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'read', arguments: '{"path":"README.md"}' },
    }));
  });

  it('does not discard identical fragments before tool arguments form complete JSON', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"value\\":\\"a"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a"}}]}}]}',
      tools,
      cb,
      state,
    );
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a\\"}"}}]},"finish_reason":"tool_calls"}]}',
      tools,
      cb,
      state,
    );
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'echo', arguments: '{"value":"aaa"}' },
    }));
  });

  it('combines truly fragmented tool names without duplicating full snapshots', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const tools = new Map<number, ToolCall>();
    processOpenAISseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_"}}]}}]}', tools, cb, state);
    processOpenAISseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather"}}]},"finish_reason":"tool_calls"}]}', tools, cb, state);
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: { name: 'get_weather', arguments: '' },
    }));
  });

  it('parses a complete non-stream response', async () => {
    const cb = callbacks();
    await processOpenAIFullResponse(new Response(JSON.stringify({
      choices: [{ message: { content: 'complete', reasoning_content: 'reason' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })), cb);
    expect(cb.onContent).toHaveBeenCalledWith('complete');
    expect(cb.onReasoning).toHaveBeenCalledWith('reason');
  });

  it('reports refusal before rejecting a content-filtered response', async () => {
    const cb = callbacks();
    await expect(processOpenAIFullResponse(new Response(JSON.stringify({
      choices: [{ message: { refusal: 'cannot comply' }, finish_reason: 'content_filter' }],
    })), cb)).rejects.toThrow('blocked by content filtering');
    expect(cb.onRefusal).toHaveBeenCalledWith('cannot comply');
    expect(cb.onOpenAIFinishReason).toHaveBeenCalledWith('content_filter');
  });

  it('records a streamed length finish reason for the request-level validator', () => {
    const cb = callbacks();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    processOpenAISseLine(
      'data: {"choices":[{"delta":{"refusal":"blocked"},"finish_reason":"length"}]}',
      new Map(), cb, state,
    );
    expect(cb.onRefusal).toHaveBeenCalledWith('blocked');
    expect(cb.onOpenAIFinishReason).toHaveBeenCalledWith('length');
  });

  it('rejects token-limit truncation after preserving partial streamed output', async () => {
    const cb = callbacks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }));

    await expect(streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb)).rejects.toThrow('output token limit');
    expect(cb.onContent).toHaveBeenCalledWith('partial');
  });

  it('parses a standard SSE event with metadata and multiple data fields', async () => {
    const cb = callbacks();
    const response = new Response([
      'event: message',
      'id: evt_1',
      'data: {"choices":[',
      'data: {"delta":{"content":"joined"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });

    await expect(processOpenAIStream(response, cb, 1_000)).resolves.toMatchObject({
      terminal: true,
      finishReason: 'stop',
    });
    expect(cb.onContent).toHaveBeenCalledWith('joined');
  });

  it('does not publish a pending tool call when the stream ends before a terminal signal', async () => {
    const cb = callbacks();
    const response = new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );

    await expect(processOpenAIStream(response, cb, 1_000)).resolves.toMatchObject({
      terminal: false,
      toolCalls: 0,
    });
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it('validates every completed tool call before publishing any of them', async () => {
    const cb = callbacks();
    const toolChunk = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'valid', arguments: '{}' } },
            { index: 1, id: 'call_2', function: { name: 'broken', arguments: '{' } },
          ],
        },
      }],
    });
    const response = new Response([
      `data: ${toolChunk}`,
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });

    await expect(processOpenAIStream(response, cb, 1_000)).rejects.toThrow('invalid tool call arguments');
    expect(cb.onToolCall).not.toHaveBeenCalled();
  });

  it('treats a terminal-only stream as completed upstream processing', async () => {
    const response = new Response('data:[DONE]\r\n\r\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    await expect(processOpenAIStream(response, callbacks(), 1_000)).resolves.toMatchObject({
      terminal: true,
      started: false,
      responseParts: 0,
    });
  });

  it('preserves Unicode split across stream chunks and cancels after the terminal event', async () => {
    const encoded = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
    const split = encoded.findIndex((value, index) => index > 10 && value >= 0x80);
    const cancel = vi.fn().mockResolvedValue(undefined);
    let readIndex = 0;
    const chunks = [encoded.slice(0, split + 1), encoded.slice(split + 1)];
    const reader = {
      read: vi.fn(async () => readIndex < chunks.length
        ? { value: chunks[readIndex++], done: false }
        : { value: undefined, done: true }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { body: { getReader: () => reader } } as unknown as Response;
    const cb = callbacks();

    await expect(processOpenAIStream(response, cb, 1_000)).resolves.toMatchObject({ terminal: true });
    expect(cb.onContent).toHaveBeenCalledWith('你好');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects malformed complete JSON', async () => {
    await expect(processOpenAIFullResponse(new Response('{'), callbacks())).rejects.toThrow('malformed JSON');
  });

  it('rejects oversized complete JSON and unbounded SSE events', async () => {
    await expect(processOpenAIFullResponse(new Response('{"choices":[]}'), callbacks(), 1_000, undefined, 4))
      .rejects.toThrow('exceeds 4 bytes');

    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ value: new TextEncoder().encode('data: 123456'), done: false }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { body: { getReader: () => reader } } as unknown as Response;
    await expect(processOpenAIStream(response, callbacks(), 1_000, undefined, 8)).rejects.toThrow('exceeds 8 bytes');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('falls back once to a non-streaming request when the relay rejects streaming', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('streaming is not supported', { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'fallback' } }] }), {
        headers: { 'content-type': 'application/json' },
      }));
    const cb = callbacks();

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ stream: false });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('accept')).toBe('text/event-stream');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('accept')).toBe('application/json');
    expect(cb.onContent).toHaveBeenCalledWith('fallback');
  });

  it('reports safe successful-response diagnostics metadata', async () => {
    const cb = { ...callbacks(), onResponse: vi.fn() };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completedStreamResponse({
      'x-request-id': 'req-safe',
      'openai-processing-ms': '42',
      'x-ratelimit-remaining-tokens': '900',
    }));

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    expect(cb.onResponse).toHaveBeenCalledWith('OpenAI', 200, 'text/event-stream', expect.objectContaining({
      requestId: 'req-safe', processingMs: 42, rateLimitRemainingTokens: '900',
      clientRequestId: expect.any(String),
    }));
  });

  it('omits processingMs when the upstream omits openai-processing-ms', async () => {
    const cb = { ...callbacks(), onResponse: vi.fn() };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completedStreamResponse());

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    const metadata = cb.onResponse.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(metadata?.processingMs).toBeUndefined();
  });

  it('sends a client request ID only when explicitly enabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => completedStreamResponse());
    const options = {
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    };
    await streamOpenAIChatCompletion(options, { model: 'gpt-test', messages: [], stream: true }, callbacks());
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-client-request-id')).toBe(false);

    await streamOpenAIChatCompletion(
      { ...options, sendClientRequestId: true },
      { model: 'gpt-test', messages: [], stream: true },
      callbacks(),
    );
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-client-request-id')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('reports safe request metadata before fetch rejects during upload', async () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket closed at https://secret.example.test'), { code: 'ECONNRESET' }),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(networkError);
    const cb = { ...callbacks(), onRequest: vi.fn(), onRequestSettled: vi.fn() };
    const request: ChatRequest = { model: 'gpt-test', messages: [], stream: true };

    await expect(streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
      sendClientRequestId: true,
    }, request, cb)).rejects.toBe(networkError);

    const requestMetadata = cb.onRequest.mock.calls[0]?.[1];
    expect(requestMetadata).toEqual({
      clientRequestId: expect.any(String),
      bodyBytes: Buffer.byteLength(JSON.stringify(request)),
      clientRequestIdSent: true,
      attempt: 1,
      stream: true,
    });
    expect(cb.onRequestSettled).toHaveBeenCalledWith('OpenAI', {
      clientRequestId: requestMetadata?.clientRequestId,
      responseReceived: false,
      signalAborted: false,
      abortSource: 'none',
      tokenCancellationRequested: false,
    });
  });

  it('uses the same local request ID in diagnostics and the optional header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completedStreamResponse());
    const cb = { ...callbacks(), onRequest: vi.fn() };

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
      sendClientRequestId: true,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-client-request-id'))
      .toBe(cb.onRequest.mock.calls[0]?.[1].clientRequestId);
  });

  it('retains a local request ID when the optional header is disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completedStreamResponse());
    const cb = { ...callbacks(), onRequest: vi.fn() };

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    expect(cb.onRequest).toHaveBeenCalledWith('OpenAI', expect.objectContaining({
      clientRequestId: expect.any(String), clientRequestIdSent: false,
    }));
  });

  it('does not hang when an oversized error body reports unsupported streaming', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`streaming is not supported ${'x'.repeat(70 * 1024)}`, { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'fallback' } }] }), {
        headers: { 'content-type': 'application/json' },
      }));
    const cb = callbacks();

    await streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, cb);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cb.onContent).toHaveBeenCalledWith('fallback');
  });

  it('rejects a partial stream that has output but no finish reason or terminal event', async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    await expect(streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, callbacks())).rejects.toThrow('before its terminal event');
  });

  it('rejects a terminal-only stream instead of silently completing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
    await expect(streamOpenAIChatCompletion({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, { model: 'gpt-test', messages: [], stream: true }, callbacks()))
      .rejects.toThrow('without any text, reasoning, or tool calls');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
