import { randomUUID } from 'node:crypto';
import { ResponsesReplayCollector } from './responsesReplay';
import { MAX_PROTOCOL_REPLAY_ITEMS } from './replayState';
import { stableJsonValue } from '../json';
import type { CancellationToken } from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import {
  fetchWithResponseTimeout,
  MAX_COMPLETE_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  readRelayErrorResponse,
  readResponseText,
  readSseStream,
  responseDiagnosticsMetadata,
} from './http';
import type {
  OpenAIUsage,
  ResponsesFullResponse,
  ResponsesOutputItemFunctionCall,
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

interface ResponsesFunctionState {
  itemId?: string;
  callId?: string;
  name?: string;
  argumentsDone?: boolean;
}

interface ResponsesStreamState {
  parts: number;
  started: boolean;
  replay?: ResponsesReplayCollector;
  functions?: Map<number, ResponsesFunctionState>;
  /** Which terminal event closed the stream: normal completion or truncation. */
  termination?: 'completed' | 'incomplete';
}

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
    if (outcome.parts === 0) {
      throw createIncompleteStreamError('Responses', 'empty-response');
    }
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
  const pendingFunctionCalls = new Map<number, ToolCall>();
  const state: ResponsesStreamState = { parts: 0, started: false };
  const terminal = await readSseStream(response, {
    protocol: 'Responses', idleTimeoutMs, token, maxEventBytes,
    onEventData: (data) => processResponsesSseData(data, pendingFunctionCalls, callbacks, state),
  });
  return { parts: state.parts, started: state.started, termination: state.termination, terminal };
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
  return processResponsesSseData(data, pendingFunctionCalls, callbacks, state);
}

function processResponsesSseData(
  data: string,
  pendingFunctionCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: ResponsesStreamState,
): boolean {
  if (!data) return false;
  const event = parseResponsesEvent(data);
  if (callbacks.onResponsesOutputItems) {
    state.replay ??= new ResponsesReplayCollector();
    state.replay.consume(event);
  }
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
        const identity = rememberFunctionIdentity(state, index, event.item.id, event.item.call_id, event.item.name);
        const prior = pendingFunctionCalls.get(index);
        if (identity.argumentsDone && prior && event.item.arguments) assertMatchingFunctionArguments(prior.function.arguments, event.item.arguments);
        const call = functionCallFromItem(event.item, index, prior);
        if (prior) call.function.arguments = prior.function.arguments;
        pendingFunctionCalls.set(index, call);
      }
      return false;
    }
    case 'response.function_call_arguments.delta': {
      const index = event.output_index ?? 0;
      const identity = rememberFunctionIdentity(state, index, event.item_id);
      if (identity.argumentsDone) {
        if (event.delta) throw createRelayStreamError('Responses', 'received function arguments after the call completed');
        return false;
      }
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
      const identity = rememberFunctionIdentity(state, index, event.item_id);
      const current = pendingFunctionCalls.get(index) ?? {
        id: identity.callId ?? identity.itemId ?? `call_${index}`, type: 'function' as const,
        function: { name: identity.name ?? '', arguments: '' },
      };
      if (event.arguments !== undefined) {
        if (identity.argumentsDone) assertMatchingFunctionArguments(current.function.arguments, event.arguments);
        current.function.arguments = event.arguments;
      }
      identity.argumentsDone = true;
      pendingFunctionCalls.set(index, current);
      return false;
    }
    case 'response.output_item.done': {
      if (event.item?.type === 'function_call') {
        const index = event.output_index ?? 0;
        completeFunctionItem(state, index, event.item, pendingFunctionCalls);
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
      if (event.type === 'response.completed') {
        // A terminal snapshot can fill omitted item events, but cannot rewrite
        // an identity or argument value already finalized by an earlier event.
        for (const [index, item] of (event.response?.output ?? []).entries()) {
          if (item.type === 'function_call') {
            completeFunctionItem(state, index, item, pendingFunctionCalls);
          } else if (state.functions?.get(index)?.argumentsDone) {
            throw createRelayStreamError('Responses', 'a completed function call changed output type');
          }
        }
      }
      if (event.response?.usage) {
        const usage = toOpenAIUsage(event.response.usage);
        if (usage) callbacks.onOpenAIUsage?.(usage);
      }
      if (state.replay) callbacks.onResponsesOutputItems?.(state.replay.finish(event.response?.output));
      state.termination = event.type === 'response.incomplete' ? 'incomplete' : 'completed';
      // Even item/argument "done" events can contain truncated JSON when the
      // response ends incomplete. Only a completed response releases calls.
      if (state.termination === 'completed') state.parts += flushFunctionCalls(pendingFunctionCalls, callbacks);
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
  if (payload.status === 'cancelled' || payload.status === 'in_progress') throw createIncompleteStreamError('Responses', 'missing-terminal-event');
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
    } else if (item.type === 'function_call' && payload.status !== 'incomplete') {
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
  if (callbacks.onResponsesOutputItems) {
    const replay = new ResponsesReplayCollector();
    callbacks.onResponsesOutputItems(replay.finish(payload.output));
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

function rememberFunctionIdentity(
  state: ResponsesStreamState, index: number, itemId?: string, callId?: string, name?: string,
): ResponsesFunctionState {
  const identities = state.functions ??= new Map();
  if (!identities.has(index) && identities.size >= MAX_PROTOCOL_REPLAY_ITEMS) {
    throw createRelayStreamError('Responses', 'received too many function calls');
  }
  const identity = identities.get(index) ?? {};
  const incoming = { itemId, callId, name };
  for (const key of ['itemId', 'callId', 'name'] as const) {
    const value = incoming[key];
    if (!value) continue;
    if (identity[key] && identity[key] !== value) {
      throw createRelayStreamError('Responses', 'received inconsistent function call identity');
    }
    identity[key] = value;
  }
  identities.set(index, identity);
  return identity;
}

function functionCallFromItem(item: ResponsesOutputItemFunctionCall, index: number, prior?: ToolCall): ToolCall {
  return { id: item.call_id ?? prior?.id ?? item.id ?? `call_${index}`, type: 'function',
    function: { name: item.name ?? prior?.function.name ?? '', arguments: item.arguments ?? prior?.function.arguments ?? '' } };
}

function completeFunctionItem(
  state: ResponsesStreamState, index: number, item: ResponsesOutputItemFunctionCall, pending: Map<number, ToolCall>,
): void {
  const identity = rememberFunctionIdentity(state, index, item.id, item.call_id, item.name);
  const prior = pending.get(index);
  const call = functionCallFromItem(item, index, prior);
  if (identity.argumentsDone && prior) assertMatchingFunctionArguments(prior.function.arguments, call.function.arguments);
  identity.argumentsDone = true;
  pending.set(index, call);
}

function assertMatchingFunctionArguments(expected: string, actual: string): void {
  if (expected === actual) return;
  // Relays may reformat the final JSON. Compare values only on this uncommon
  // path; the standard identical snapshots need no extra parsing or cloning.
  try {
    if (JSON.stringify(stableJsonValue(JSON.parse(expected.trim() || '{}')))
      === JSON.stringify(stableJsonValue(JSON.parse(actual.trim() || '{}')))) return;
  } catch { /* Report the protocol disagreement without exposing arguments. */ }
  throw createRelayStreamError('Responses', 'received inconsistent function call arguments');
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
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: cachedTokens === undefined && cacheWriteTokens === undefined ? undefined : {
      ...(cachedTokens === undefined ? {} : { cached_tokens: cachedTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
    },
    completion_tokens_details: reasoningTokens === undefined ? undefined : { reasoning_tokens: reasoningTokens },
  };
}
