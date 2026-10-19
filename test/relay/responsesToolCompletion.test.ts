import { describe, expect, it, vi } from 'vitest';
import { processResponsesFullResponse, processResponsesStream } from '../../src/relay/openaiResponses';
import type { ResponsesOutputItemFunctionCall, ResponsesStreamEvent, StreamCallbacks } from '../../src/relay/types';

const item: ResponsesOutputItemFunctionCall = {
  type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search', arguments: '{"q":"docs","limit":1}',
};
const added: ResponsesStreamEvent = { type: 'response.output_item.added', output_index: 0,
  item: { ...item, arguments: '', status: 'in_progress' } };
const argumentsDone = (value = item.arguments): ResponsesStreamEvent => ({
  type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: value,
});
const itemDone = (changes: Partial<ResponsesOutputItemFunctionCall> = {}): ResponsesStreamEvent => ({
  type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', ...changes },
});
const completed: ResponsesStreamEvent = { type: 'response.completed', response: { status: 'completed', output: [item] } };

function fixture(events: ResponsesStreamEvent[]) {
  const callbacks = { onContent: vi.fn(), onReasoning: vi.fn(), onToolCall: vi.fn(),
    onResponsesOutputItems: vi.fn() } satisfies StreamCallbacks;
  const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
  return { callbacks, result: () => processResponsesStream(response, callbacks, 1_000) };
}

describe('Responses function-call completion', () => {
  it('emits one callback for the standard argument-done/item-done/terminal sequence', async () => {
    const { callbacks, result } = fixture([added, argumentsDone(), itemDone(), completed]);
    await expect(result()).resolves.toMatchObject({ terminal: true, parts: 1 });
    expect(callbacks.onToolCall).toHaveBeenCalledExactlyOnceWith({ id: 'call_1', type: 'function',
      function: { name: 'search', arguments: item.arguments } });
    expect(callbacks.onResponsesOutputItems).toHaveBeenCalledExactlyOnceWith([item]);
  });

  it('keeps replay updates while accepting repeated equivalent completed events', async () => {
    const reformatted = '{ "limit": 1, "q": "docs" }';
    const { callbacks, result } = fixture([added, argumentsDone(), argumentsDone(reformatted),
      itemDone({ arguments: reformatted }), itemDone(),
      { type: 'response.completed', response: { status: 'completed' } }]);
    await expect(result()).resolves.toMatchObject({ terminal: true, parts: 1 });
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onResponsesOutputItems).toHaveBeenCalledExactlyOnceWith([{ ...item, status: 'completed' }]);
  });

  it.each([
    { id: 'different-item' }, { call_id: 'different-call' }, { name: 'different-tool' },
    { arguments: '{"q":"different","limit":1}' },
  ])('rejects conflicting completion fields before any callback: %j', async change => {
    const { callbacks, result } = fixture([added, argumentsDone(), itemDone(change), completed]);
    await expect(result()).rejects.toThrow(/inconsistent function call/);
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
    expect(callbacks.onResponsesOutputItems).not.toHaveBeenCalled();
  });

  it('rejects a terminal snapshot that changes finalized arguments', async () => {
    const { callbacks, result } = fixture([added, argumentsDone(), itemDone(), {
      type: 'response.completed', response: { status: 'completed', output: [{ ...item, arguments: '{"q":"changed"}' }] },
    }]);
    await expect(result()).rejects.toThrow('inconsistent function call arguments');
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
  });

  it('allows an authoritative item snapshot to finish partial deltas when no arguments-done arrived', async () => {
    const { callbacks, result } = fixture([added, { type: 'response.function_call_arguments.delta',
      output_index: 0, item_id: item.id, delta: '{"q":' }, itemDone(), completed]);
    await expect(result()).resolves.toMatchObject({ terminal: true, parts: 1 });
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
  });

  it.each([
    [added, argumentsDone(), { type: 'response.completed', response: { status: 'completed' } }],
    [itemDone(), completed],
    [completed],
  ] as ResponsesStreamEvent[][])('retains a complete call when intermediate events are omitted', async (...events) => {
    const { callbacks, result } = fixture(events);
    await expect(result()).resolves.toMatchObject({ terminal: true, parts: 1 });
    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'incomplete'])('does not parse or emit truncated tools before incomplete, item status=%s', async status => {
    const partial = '{"q":';
    const { callbacks, result } = fixture([added,
      { type: 'response.output_text.delta', output_index: 1, delta: 'partial answer' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: partial },
      argumentsDone(partial), itemDone({ arguments: partial, status }),
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ]);
    callbacks.onToolCall.mockImplementation(call => { JSON.parse(call.function.arguments); });
    await expect(result()).resolves.toMatchObject({ terminal: true, termination: 'incomplete', parts: 1 });
    expect(callbacks.onContent).toHaveBeenCalledExactlyOnceWith('partial answer');
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
  });

  it('does not release a completed item when the stream fails before its terminal event', async () => {
    const { callbacks, result } = fixture([added, argumentsDone(), itemDone(),
      { type: 'response.failed', response: { status: 'failed', error: { message: 'failed' } } }]);
    await expect(result()).rejects.toThrow();
    expect(callbacks.onToolCall).not.toHaveBeenCalled();
  });

  it('preserves partial text without parsing truncated tools in a full incomplete envelope', async () => {
    const onToolCall = vi.fn((call: { function: { arguments: string } }) => { JSON.parse(call.function.arguments); });
    const onContent = vi.fn();
    const response = new Response(JSON.stringify({ status: 'incomplete', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial answer' }] },
      { ...item, arguments: '{"q":', status: 'incomplete' },
    ] }));
    await expect(processResponsesFullResponse(response, { onContent, onToolCall, onReasoning: () => undefined }))
      .resolves.toBe('incomplete');
    expect(onContent).toHaveBeenCalledExactlyOnceWith('partial answer');
    expect(onToolCall).not.toHaveBeenCalled();
  });
});
