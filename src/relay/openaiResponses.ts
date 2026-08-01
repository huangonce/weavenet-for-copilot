import { randomUUID } from 'node:crypto';
import type { CancellationToken } from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import {
  consumeSseChunk,
  fetchWithResponseTimeout,
  MAX_COMPLETE_RESPONSE_BYTES,
  readRelayErrorResponse,
  readResponseText,
  readWithIdleTimeout,
  responseDiagnosticsMetadata,
} from './http';
import type {
  OpenAIUsage,
  ResponsesFullResponse,
  ResponsesRequest,
  ResponsesStreamEvent,
  StreamCallbacks,
  ToolCall,
} from './types';
import { relayEndpointUrl } from './url';

export interface OpenAIResponsesRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly sendClientRequestId?: boolean;
}

interface ResponsesStreamState {
  parts: number;
  started: boolean;
  /** Which terminal event closed the stream: normal completion or truncation. */
  termination?: 'completed' | 'incomplete';
}

const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export async function streamOpenAIResponses(
  options: OpenAIResponsesRequestOptions,
  request: ResponsesRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  // The Responses protocol never falls back to another protocol on failure.
  // Each logical request produces exactly one POST to /responses.
  const clientRequestId = randomUUID();
  const body = JSON.stringify(request);
  callbacks.onRequest?.('Responses', {
    clientRequestId,
    bodyBytes: Buffer.byteLength(body),
    clientRequestIdSent: options.sendClientRequestId === true,
    attempt: 1,
    stream: request.stream,
  });
  // Never retry network-level POST failures. The upstream may already have
  // accepted the request, which could duplicate billing or tool execution.
  const response = await fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'responses'), {
    method: 'POST',
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      Accept: request.stream ? 'text/event-stream' : 'application/json',
      ...(options.sendClientRequestId ? { 'X-Client-Request-Id': clientRequestId } : {}),
    },
    body,
  }, options.requestTimeoutMs, token, (diagnostics) => callbacks.onRequestSettled?.('Responses', {
    clientRequestId,
    ...diagnostics,
  }));
  callbacks.onResponse?.(
    'Responses',
    response.status,
    response.headers.get('content-type') ?? 'unknown',
    { ...responseDiagnosticsMetadata(response), clientRequestId },
  );
  if (!response.ok) {
    const failure = await readRelayErrorResponse(response, options.streamIdleTimeoutMs, token);
    throw failure.error;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!request.stream || !contentType.includes('text/event-stream')) {
    const termination = await processResponsesFullResponse(response, callbacks, options.streamIdleTimeoutMs, token);
    callbacks.onStreamEnd?.('Responses', termination);
    return;
  }

  const outcome = await processResponsesStream(response, callbacks, options.streamIdleTimeoutMs, token);
  if (outcome.terminal) {
    callbacks.onStreamEnd?.('Responses', outcome.termination ?? 'completed');
    return;
  }
  throw createIncompleteStreamError(
    'Responses',
    outcome.parts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
  );
}

export async function processResponsesStream(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
): Promise<{ parts: number; started: boolean; terminal: boolean; termination?: 'completed' | 'incomplete' }> {
  if (!response.body) throw new Error('Relay returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingFunctionCalls = new Map<number, ToolCall>();
  const state: ResponsesStreamState = { parts: 0, started: false };
  let buffer = '';
  let terminal = false;
  try {
    while (!terminal) {
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, token);
      if (done) break;
      const consumed = consumeSseChunk(
        value,
        decoder,
        buffer,
        maxEventBytes,
        (line) => processResponsesSseLine(line, pendingFunctionCalls, callbacks, state),
        () => createRelayStreamError('Responses', `SSE event exceeds ${maxEventBytes} bytes`),
      );
      buffer = consumed.buffer;
      terminal = consumed.stopped;
    }
    if (!terminal) {
      const consumed = consumeSseChunk(
        undefined,
        decoder,
        buffer,
        maxEventBytes,
        (line) => processResponsesSseLine(line, pendingFunctionCalls, callbacks, state),
        () => createRelayStreamError('Responses', `SSE event exceeds ${maxEventBytes} bytes`),
      );
      buffer = consumed.buffer;
      terminal = consumed.stopped;
    }
    if (!terminal && buffer.trim()) {
      terminal = processResponsesSseLine(buffer, pendingFunctionCalls, callbacks, state);
    }
    state.parts += flushFunctionCalls(pendingFunctionCalls, callbacks);
    return { ...state, terminal };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function processResponsesSseLine(
  line: string,
  pendingFunctionCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: ResponsesStreamState,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
  const data = trimmed.slice('data:'.length).trim();
  if (!data) return false;
  const event = parseResponsesEvent(data);
  switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      if (!state.started) {
        state.started = true;
        callbacks.onProcessingStarted?.('Responses');
      }
      return false;
    case 'response.output_text.delta':
      if (event.delta) {
        callbacks.onContent(event.delta);
        state.parts++;
      }
      return false;
    case 'response.refusal.delta':
      if (event.delta) {
        callbacks.onRefusal?.(event.delta);
        state.parts++;
      }
      return false;
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      if (event.delta) {
        callbacks.onReasoning(event.delta);
        state.parts++;
      }
      return false;
    case 'response.output_item.added': {
      if (event.item?.type === 'function_call') {
        const index = event.output_index ?? 0;
        pendingFunctionCalls.set(index, {
          id: event.item.call_id ?? event.item.id ?? `call_${index}`,
          type: 'function',
          function: { name: event.item.name ?? '', arguments: '' },
        });
      }
      return false;
    }
    case 'response.function_call_arguments.delta': {
      const index = event.output_index ?? 0;
      const current = pendingFunctionCalls.get(index) ?? {
        id: `call_${index}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      current.function.arguments += event.delta ?? '';
      pendingFunctionCalls.set(index, current);
      return false;
    }
    case 'response.function_call_arguments.done': {
      const index = event.output_index ?? 0;
      const current = pendingFunctionCalls.get(index);
      if (current) {
        if (event.arguments !== undefined) current.function.arguments = event.arguments;
        state.parts += flushFunctionCall(index, pendingFunctionCalls, callbacks);
      }
      return false;
    }
    case 'response.output_item.done': {
      if (event.item?.type === 'function_call') {
        const index = event.output_index ?? 0;
        const current = pendingFunctionCalls.get(index);
        if (current) {
          if (event.item.arguments) current.function.arguments = event.item.arguments;
          state.parts += flushFunctionCall(index, pendingFunctionCalls, callbacks);
        }
      } else if (event.item?.type === 'reasoning') {
        // Carries the server-side `id` and, with `include: ["reasoning.encrypted_content"]`,
        // the encrypted payload that a stateless replay must send back verbatim.
        callbacks.onResponsesReasoningItem?.(event.item);
      }
      return false;
    }
    case 'response.completed':
    case 'response.incomplete':
      // `response.incomplete` is a legitimate terminal event (e.g. the model
      // hit max_output_tokens). The partially generated output is still valid,
      // so it is reported as a terminal event rather than an error; the
      // termination value distinguishes truncation from normal completion.
      if (event.response?.usage) {
        const usage = toOpenAIUsage(event.response.usage);
        if (usage) callbacks.onOpenAIUsage?.(usage);
      }
      state.termination = event.type === 'response.incomplete' ? 'incomplete' : 'completed';
      state.parts += flushFunctionCalls(pendingFunctionCalls, callbacks);
      return true;
    case 'response.failed':
      throw createRelayStreamError('Responses', event.response?.error ?? 'response failed');
    case 'error':
      throw createRelayStreamError('Responses', event.error ?? 'relay stream error');
    default:
      return false;
  }
}

export async function processResponsesFullResponse(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs = 60_000,
  token?: CancellationToken,
  maxBodyBytes = MAX_COMPLETE_RESPONSE_BYTES,
  allowEmptyOutput = false,
): Promise<'completed' | 'incomplete'> {
  const body = await readResponseText(response, idleTimeoutMs, token, maxBodyBytes);
  let payload: ResponsesFullResponse;
  try {
    payload = JSON.parse(body) as ResponsesFullResponse;
  } catch {
    throw createRelayStreamError('Responses', 'received malformed JSON from the relay');
  }
  if (payload.error) throw createRelayStreamError('Responses', payload.error);
  if (payload.status === 'failed') throw createRelayStreamError('Responses', 'response failed');
  if (payload.usage) {
    const usage = toOpenAIUsage(payload.usage);
    if (usage) callbacks.onOpenAIUsage?.(usage);
  }
  let parts = 0;
  for (const item of payload.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) {
          callbacks.onContent(part.text);
          parts++;
        } else if (part.type === 'refusal' && part.refusal) {
          callbacks.onRefusal?.(part.refusal);
          parts++;
        }
      }
    } else if (item.type === 'function_call') {
      callbacks.onToolCall({
        id: item.call_id ?? item.id ?? 'call',
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
      parts++;
    } else if (item.type === 'reasoning') {
      // Surfaced in full so the caller can replay the real item verbatim.
      callbacks.onResponsesReasoningItem?.(item);
      for (const part of [...(item.summary ?? []), ...(item.content ?? [])]) {
        if (part.text) {
          callbacks.onReasoning(part.text);
          parts++;
        }
      }
    }
  }
  // Reasoning models burn the whole `max_output_tokens: 1` budget on thinking
  // and legitimately end `incomplete` with only reasoning items; capability
  // probes accept that, real chat responses still require visible output.
  if (parts === 0 && !allowEmptyOutput) throw createIncompleteStreamError('Responses', 'empty-response');
  // `status === 'incomplete'` (e.g. max_output_tokens truncation) is not an
  // error: the partial output above was still delivered to the caller. The
  // return value lets the caller distinguish truncation in its terminal log.
  return payload.status === 'incomplete' ? 'incomplete' : 'completed';
}

function flushFunctionCall(
  index: number,
  pending: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
): number {
  const toolCall = pending.get(index);
  if (!toolCall?.function.name) return 0;
  pending.delete(index);
  callbacks.onToolCall(toolCall);
  return 1;
}

function flushFunctionCalls(pending: Map<number, ToolCall>, callbacks: StreamCallbacks): number {
  let count = 0;
  for (const index of [...pending.keys()].sort((a, b) => a - b)) {
    count += flushFunctionCall(index, pending, callbacks);
  }
  return count;
}

function parseResponsesEvent(value: string): ResponsesStreamEvent {
  try {
    return JSON.parse(value) as ResponsesStreamEvent;
  } catch {
    throw createRelayStreamError('Responses', 'received malformed JSON from the relay');
  }
}

function toOpenAIUsage(usage: ResponsesFullResponse['usage'] | ResponsesStreamEvent['usage']): OpenAIUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: cachedTokens === undefined ? undefined : { cached_tokens: cachedTokens },
    completion_tokens_details: reasoningTokens === undefined ? undefined : { reasoning_tokens: reasoningTokens },
  };
}
