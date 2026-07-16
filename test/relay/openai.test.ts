import { describe, expect, it, vi } from 'vitest';
import { processOpenAIFullResponse, processOpenAISseLine, processOpenAIStream, streamOpenAIChatCompletion } from '../../src/relay/openai';
import type { StreamCallbacks } from '../../src/relay/client';
import type { ToolCall } from '../../src/relay/types';

function callbacks() {
  return {
    onContent: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onProcessingStarted: vi.fn(),
    onOpenAIUsage: vi.fn(),
  } satisfies StreamCallbacks;
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
});
