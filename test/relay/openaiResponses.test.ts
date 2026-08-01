import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  processResponsesFullResponse,
  processResponsesSseLine,
  processResponsesStream,
  streamOpenAIResponses,
} from '../../src/relay/openaiResponses';
import { RelayStreamError } from '../../src/relay/errors';
import { createIncompleteStreamError } from '../../src/relay/errors';
import type { ResponsesRequest, StreamCallbacks, ToolCall } from '../../src/relay/types';

afterEach(() => vi.restoreAllMocks());

function callbacks() {
  return {
    onContent: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onResponsesReasoningItem: vi.fn(),
    onRefusal: vi.fn(),
    onOpenAIFinishReason: vi.fn(),
    onProcessingStarted: vi.fn(),
    onOpenAIUsage: vi.fn(),
    onStreamEnd: vi.fn(),
    onResponse: vi.fn(),
    onRequest: vi.fn(),
    onRequestSettled: vi.fn(),
  } satisfies StreamCallbacks;
}

function responsesRequest(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: 'gpt-test', input: [{ role: 'user', content: 'hi' }], stream: true, ...overrides };
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function streamState() {
  return { parts: 0, started: false };
}

describe('Responses SSE parsing', () => {
  it('streams text deltas and reports the completed terminal event', () => {
    const cb = callbacks();
    const tools = new Map<number, ToolCall>();
    const state = streamState();
    processResponsesSseLine('data: {"type":"response.in_progress"}', tools, cb, state);
    processResponsesSseLine('data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}', tools, cb, state);
    processResponsesSseLine('data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" world"}', tools, cb, state);
    const terminal = processResponsesSseLine(
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":7,"total_tokens":12}}}',
      tools,
      cb,
      state,
    );
    expect(terminal).toBe(true);
    expect(cb.onContent).toHaveBeenNthCalledWith(1, 'Hello');
    expect(cb.onContent).toHaveBeenNthCalledWith(2, ' world');
    expect(cb.onProcessingStarted).toHaveBeenCalledWith('Responses');
    expect(cb.onOpenAIUsage).toHaveBeenCalledWith({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('treats response.incomplete as a terminal event and reports usage', () => {
    const cb = callbacks();
    const tools = new Map<number, ToolCall>();
    const state = streamState();
    const terminal = processResponsesSseLine(
      'data: {"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}',
      tools,
      cb,
      state,
    );
    expect(terminal).toBe(true);
    expect(cb.onOpenAIUsage).toHaveBeenCalledWith({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('maps reasoning text deltas to onReasoning', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    processResponsesSseLine('data: {"type":"response.reasoning_text.delta","output_index":0,"content_index":0,"delta":"think"}', tools, cb, state);
    processResponsesSseLine('data: {"type":"response.reasoning_summary_text.delta","output_index":0,"content_index":0,"delta":"summary"}', tools, cb, state);
    expect(cb.onReasoning).toHaveBeenNthCalledWith(1, 'think');
    expect(cb.onReasoning).toHaveBeenNthCalledWith(2, 'summary');
  });

  it('maps refusal deltas to onRefusal', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    processResponsesSseLine('data: {"type":"response.refusal.delta","output_index":0,"content_index":0,"delta":"I cannot"}', tools, cb, state);
    expect(cb.onRefusal).toHaveBeenCalledWith('I cannot');
  });

  it('assembles streaming function calls from item and argument events', () => {
    const cb = callbacks();
    const tools = new Map<number, ToolCall>();
    const state = streamState();
    processResponsesSseLine(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":"","status":"in_progress"}}',
      tools,
      cb,
      state,
    );
    processResponsesSseLine('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"location\\":"}', tools, cb, state);
    processResponsesSseLine('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\\"北京\\"}"}', tools, cb, state);
    processResponsesSseLine(
      'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"location\\":\\"北京\\"}"}',
      tools,
      cb,
      state,
    );
    expect(cb.onToolCall).toHaveBeenCalledWith({
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"location":"北京"}' },
    });
  });

  it('throws a stream error on response.failed', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    expect(() => processResponsesSseLine(
      'data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}',
      tools,
      cb,
      state,
    )).toThrow(RelayStreamError);
  });

  it('throws a stream error on error events', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    expect(() => processResponsesSseLine(
      'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}',
      tools,
      cb,
      state,
    )).toThrow(RelayStreamError);
  });

  it('throws malformed JSON errors for invalid event payloads', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    expect(() => processResponsesSseLine('data: {not json', tools, cb, state)).toThrow(RelayStreamError);
  });

  it('captures the completed reasoning item including encrypted_content', () => {
    const cb = callbacks();
    const tools = new Map();
    const state = streamState();
    processResponsesSseLine(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[],"content":[]}}',
      tools,
      cb,
      state,
    );
    processResponsesSseLine(
      'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","output_index":0,"content_index":0,"delta":"think"}',
      tools,
      cb,
      state,
    );
    processResponsesSseLine(
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"short"}],"content":[{"type":"reasoning_text","text":"think"}],"encrypted_content":"enc:abc123"}}',
      tools,
      cb,
      state,
    );
    expect(cb.onResponsesReasoningItem).toHaveBeenCalledWith({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'short' }],
      content: [{ type: 'reasoning_text', text: 'think' }],
      encrypted_content: 'enc:abc123',
    });
    expect(cb.onReasoning).toHaveBeenCalledWith('think');
  });
});

describe('Responses full response parsing', () => {
  it('maps message, function call, and reasoning output items', async () => {
    const cb = callbacks();
    const response = new Response(JSON.stringify({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 6 },
        total_tokens: 30,
      },
      output: [
        { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [
          { type: 'output_text', text: 'answer' },
          { type: 'refusal', refusal: 'refused part' },
        ] },
        { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'short' }], content: [{ type: 'reasoning_text', text: 'long thought' }] },
        { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"docs"}', status: 'completed' },
      ],
    }), { headers: { 'content-type': 'application/json' } });

    await processResponsesFullResponse(response, cb);

    expect(cb.onContent).toHaveBeenCalledWith('answer');
    expect(cb.onRefusal).toHaveBeenCalledWith('refused part');
    expect(cb.onReasoning).toHaveBeenNthCalledWith(1, 'short');
    expect(cb.onReasoning).toHaveBeenNthCalledWith(2, 'long thought');
    expect(cb.onToolCall).toHaveBeenCalledWith({
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"docs"}' },
    });
    expect(cb.onOpenAIUsage).toHaveBeenCalledWith({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 6 },
    });
    expect(cb.onResponsesReasoningItem).toHaveBeenCalledWith({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'short' }],
      content: [{ type: 'reasoning_text', text: 'long thought' }],
    });
  });

  it('passes through encrypted reasoning content from a full response', async () => {
    const cb = callbacks();
    const response = new Response(JSON.stringify({
      id: 'resp_1',
      status: 'completed',
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'think' }], encrypted_content: 'enc:xyz' },
      ],
    }), { headers: { 'content-type': 'application/json' } });

    await processResponsesFullResponse(response, cb);

    expect(cb.onResponsesReasoningItem).toHaveBeenCalledWith({
      id: 'rs_1',
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'think' }],
      encrypted_content: 'enc:xyz',
    });
  });

  it('throws when the response status is failed', async () => {
    const cb = callbacks();
    const response = new Response(JSON.stringify({
      status: 'failed',
      error: { code: 'server_error', message: 'upstream exploded' },
      output: [],
    }), { headers: { 'content-type': 'application/json' } });
    await expect(processResponsesFullResponse(response, cb)).rejects.toThrow(RelayStreamError);
  });

  it('delivers partial output and returns incomplete for a truncated full response', async () => {
    const cb = callbacks();
    const response = new Response(JSON.stringify({
      id: 'resp_1',
      status: 'incomplete',
      output: [
        { id: 'msg_1', type: 'message', role: 'assistant', status: 'incomplete', content: [
          { type: 'output_text', text: 'partial answer' },
        ] },
      ],
    }), { headers: { 'content-type': 'application/json' } });

    await expect(processResponsesFullResponse(response, cb)).resolves.toBe('incomplete');
    expect(cb.onContent).toHaveBeenCalledWith('partial answer');
  });

  it('throws when an empty response contains no output parts', async () => {
    const cb = callbacks();
    const response = new Response(JSON.stringify({ status: 'completed', output: [] }), { headers: { 'content-type': 'application/json' } });
    await expect(processResponsesFullResponse(response, cb)).rejects.toThrow(createIncompleteStreamError('Responses', 'empty-response').message);
  });

  it('throws malformed JSON errors for invalid full responses', async () => {
    const cb = callbacks();
    const response = new Response('{oops', { headers: { 'content-type': 'application/json' } });
    await expect(processResponsesFullResponse(response, cb)).rejects.toThrow(RelayStreamError);
  });
});

describe('streamOpenAIResponses', () => {
  it('performs a streaming request and reports the completed terminal event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
    ]));
    const cb = callbacks();
    await streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest(), cb);
    expect(cb.onContent).toHaveBeenCalledWith('hi');
    expect(cb.onStreamEnd).toHaveBeenCalledWith('Responses', 'completed');
    expect(cb.onResponse).toHaveBeenCalledWith('Responses', 200, expect.stringContaining('text/event-stream'), expect.objectContaining({ clientRequestId: expect.any(String) }));
  });

  it('reports an incomplete terminal event when the upstream truncates the response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\n\n',
      'data: {"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete"}}\n\n',
    ]));
    const cb = callbacks();
    await streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest(), cb);
    expect(cb.onContent).toHaveBeenCalledWith('partial');
    expect(cb.onStreamEnd).toHaveBeenCalledWith('Responses', 'incomplete');
  });

  it('throws when the stream ends without a terminal event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\n\n',
    ]));
    const cb = callbacks();
    await expect(streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest(), cb)).rejects.toThrow(RelayStreamError);
  });

  it('handles non-streaming JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'completed',
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    }), { headers: { 'content-type': 'application/json' } }));
    const cb = callbacks();
    await streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest({ stream: false }), cb);
    expect(cb.onContent).toHaveBeenCalledWith('ok');
    expect(cb.onStreamEnd).toHaveBeenCalledWith('Responses', 'completed');
  });

  it('delivers partial output for a non-streaming incomplete response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_1',
      status: 'incomplete',
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial answer' }] }],
    }), { headers: { 'content-type': 'application/json' } }));
    const cb = callbacks();
    await streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest({ stream: false }), cb);
    expect(cb.onContent).toHaveBeenCalledWith('partial answer');
    expect(cb.onStreamEnd).toHaveBeenCalledWith('Responses', 'incomplete');
  });

  it('reports safe request metadata before fetch rejects during upload and never retries', async () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError);
    const cb = callbacks();
    const request = responsesRequest();

    await expect(streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
      sendClientRequestId: true,
    }, request, cb)).rejects.toBe(networkError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-client-request-id'))
      .toBe(cb.onRequest.mock.calls[0]?.[1].clientRequestId);
    expect(cb.onRequest).toHaveBeenCalledWith('Responses', expect.objectContaining({
      bodyBytes: Buffer.byteLength(JSON.stringify(request)),
      clientRequestIdSent: true,
      attempt: 1,
      stream: true,
    }));
    expect(cb.onRequestSettled).toHaveBeenCalledWith('Responses', {
      clientRequestId: expect.any(String),
      responseReceived: false,
      signalAborted: false,
      abortSource: 'none',
      tokenCancellationRequested: false,
    });
  });

  it('uses the responses endpoint exactly once', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
    ]));
    const cb = callbacks();
    await streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest(), cb);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://relay.example.test/v1/responses');
  });

  it('throws relay request errors for HTTP failures without protocol fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'model not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    const cb = callbacks();
    await expect(streamOpenAIResponses({
      baseUrl: 'https://relay.example.test/v1', headers: {}, requestTimeoutMs: 100, streamIdleTimeoutMs: 100,
    }, responsesRequest(), cb)).rejects.toThrow(/Relay request failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized SSE events', async () => {
    const oversized = sseResponse([
      `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"${'x'.repeat(2 * 1024 * 1024)}"}\n\n`,
    ]);
    const cb = callbacks();
    await expect(processResponsesStream(oversized, cb, 100)).rejects.toThrow(RelayStreamError);
  });
});
