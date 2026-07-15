import { describe, expect, it, vi } from 'vitest';
import { processOpenAIFullResponse, processOpenAISseLine, processOpenAIStream } from '../src/relay/openai';
import type { StreamCallbacks } from '../src/relay/client';
import type { ToolCall } from '../src/relay/types';

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
    const state = { parts: 0, started: false, terminal: false };
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
    const state = { parts: 0, started: false, terminal: false };
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

  it('rejects malformed complete JSON', async () => {
    await expect(processOpenAIFullResponse(new Response('{'), callbacks())).rejects.toThrow('malformed JSON');
  });
});
