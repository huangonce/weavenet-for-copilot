import { randomUUID } from 'node:crypto';
import type { CancellationToken } from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { fetchWithResponseTimeout, MAX_COMPLETE_RESPONSE_BYTES, MAX_SSE_EVENT_BYTES, readRelayErrorResponse, readResponseText, readSseStream, responseDiagnosticsMetadata } from './http';
import type { ChatRequest, OpenAIFullResponse, StreamCallbacks, StreamChunk, ToolCall } from './types';
import { relayEndpointUrl } from './url';

export interface OpenAIRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly sendClientRequestId?: boolean;
}

interface OpenAIStreamState {
  responseParts: number;
  started: boolean;
  sawFinishReason: boolean;
  finishReason?: string;
  toolCalls?: number;
  pendingToolBytes?: number;
  pendingArgumentEnds?: Map<number, number>;
}

// Local Extension Host memory guards, not upstream API limits. The event size
// guard alone cannot bound a tool assembled from arbitrarily many small deltas.
const MAX_PENDING_TOOL_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS = 512;

export async function streamOpenAIChatCompletion(
  options: OpenAIRequestOptions,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  let currentRequest = request;
  const clientRequestId = randomUUID();
  let attempt = 0;
  while (true) {
    attempt++;
    const response = await fetchOpenAI(options, currentRequest, clientRequestId, attempt, callbacks, token);
    callbacks.onResponse?.(
      'OpenAI',
      response.status,
      response.headers.get('content-type') ?? 'unknown',
      { ...responseDiagnosticsMetadata(response), clientRequestId },
    );
    if (!response.ok) {
      const failure = await readRelayErrorResponse(response, options.streamIdleTimeoutMs, token);
      if (currentRequest.stream && isStreamingUnsupported(response.status, response.statusText, failure.body)) {
        currentRequest = { ...request, stream: false, stream_options: undefined };
        continue;
      }
      throw failure.error;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!currentRequest.stream || !contentType.includes('text/event-stream')) {
      await processOpenAIFullResponse(response, callbacks, options.streamIdleTimeoutMs, token);
      callbacks.onStreamEnd?.('OpenAI', 'finish_reason');
      return;
    }

    const outcome = await processOpenAIStream(response, callbacks, options.streamIdleTimeoutMs, token);
    if (outcome.terminal || (outcome.responseParts > 0 && outcome.sawFinishReason)) {
      validateOpenAIFinishReason(outcome.finishReason, outcome.toolCalls);
      if (outcome.responseParts === 0) {
        throw createIncompleteStreamError('OpenAI', 'empty-response');
      }
      callbacks.onStreamEnd?.('OpenAI', outcome.terminal ? '[DONE]' : 'finish_reason');
      return;
    }
    throw createIncompleteStreamError(
      'OpenAI',
      outcome.responseParts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
    );
  }
}

async function fetchOpenAI(
  options: OpenAIRequestOptions,
  request: ChatRequest,
  clientRequestId: string,
  attempt: number,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<Response> {
  const body = JSON.stringify(request);
  callbacks.onRequest?.('OpenAI', {
    clientRequestId,
    bodyBytes: Buffer.byteLength(body),
    clientRequestIdSent: options.sendClientRequestId === true,
    attempt,
    stream: request.stream,
  });
  // Never retry network-level POST failures. The upstream may already have
  // accepted the request, which could duplicate billing or tool execution.
  return fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      Accept: request.stream ? 'text/event-stream' : 'application/json',
      ...(options.sendClientRequestId ? { 'X-Client-Request-Id': clientRequestId } : {}),
    },
    body,
  }, options.requestTimeoutMs, token, (diagnostics) => callbacks.onRequestSettled?.('OpenAI', {
    clientRequestId,
    ...diagnostics,
  }));
}

export async function processOpenAIStream(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
): Promise<{
  responseParts: number;
  started: boolean;
  sawFinishReason: boolean;
  finishReason?: string;
  toolCalls: number;
  terminal: boolean;
}> {
  const pendingToolCalls = new Map<number, ToolCall>();
  const state: OpenAIStreamState = { responseParts: 0, started: false, sawFinishReason: false };
  const terminal = await readSseStream(response, {
    protocol: 'OpenAI', idleTimeoutMs, token, maxEventBytes,
    onEventData: (data) => processOpenAISseData(data, pendingToolCalls, callbacks, state),
  });
  if (terminal && !state.sawFinishReason) {
    const flushed = flushToolCalls(pendingToolCalls, callbacks);
    state.pendingToolBytes = 0;
    state.pendingArgumentEnds?.clear();
    state.responseParts += flushed;
    state.toolCalls = (state.toolCalls ?? 0) + flushed;
  } else if ((terminal || state.sawFinishReason) && pendingToolCalls.size > 0) {
    throw createRelayStreamError(
      'OpenAI',
      `finish_reason=${state.finishReason ?? 'unknown'} was received with unfinished tool calls`,
    );
  }
  return {
    responseParts: state.responseParts, started: state.started, sawFinishReason: state.sawFinishReason,
    finishReason: state.finishReason, toolCalls: state.toolCalls ?? 0, terminal,
  };
}

export function processOpenAISseLine(
  line: string,
  pendingToolCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: OpenAIStreamState,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
  const data = trimmed.slice('data:'.length).trim();
  return processOpenAISseData(data, pendingToolCalls, callbacks, state);
}

function processOpenAISseData(
  data: string,
  pendingToolCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: OpenAIStreamState,
): boolean {
  if (data === '[DONE]') return true;
  if (!data) return false;
  const chunk = parseOpenAIStreamJson(data);
  if (chunk.error) throw createRelayStreamError('OpenAI', chunk.error);
  if (chunk.usage) {
    if (!state.started) {
      state.started = true;
      callbacks.onProcessingStarted?.('OpenAI');
    }
    callbacks.onOpenAIUsage?.(chunk.usage);
  }
  const choice = chunk.choices?.[0];
  if (choice && (Object.hasOwn(choice, 'delta') || Object.hasOwn(choice, 'finish_reason'))) {
    if (!state.started) {
      state.started = true;
      callbacks.onProcessingStarted?.('OpenAI');
    }
  }
  const delta = choice?.delta;
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (reasoning) {
    callbacks.onReasoning(reasoning);
    state.responseParts++;
  }
  if (delta?.content) {
    callbacks.onContent(delta.content);
    state.responseParts++;
  }
  if (delta?.refusal) {
    callbacks.onRefusal?.(delta.refusal);
    state.responseParts++;
  }
  if (delta?.tool_calls) mergeToolCallDeltas(delta.tool_calls, pendingToolCalls, state);
  if (choice?.finish_reason) {
    state.sawFinishReason = true;
    state.finishReason = choice.finish_reason;
    callbacks.onOpenAIFinishReason?.(choice.finish_reason);
    if (choice.finish_reason === 'tool_calls') {
      const flushed = flushToolCalls(pendingToolCalls, callbacks);
      state.pendingToolBytes = 0;
      state.pendingArgumentEnds?.clear();
      state.responseParts += flushed;
      state.toolCalls = (state.toolCalls ?? 0) + flushed;
    }
  }
  return false;
}

export async function processOpenAIFullResponse(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs = 60_000,
  token?: CancellationToken,
  maxBodyBytes = MAX_COMPLETE_RESPONSE_BYTES,
): Promise<void> {
  const body = await readResponseText(response, idleTimeoutMs, token, maxBodyBytes);
  let payload: OpenAIFullResponse;
  try {
    payload = JSON.parse(body) as OpenAIFullResponse;
  } catch {
    throw createRelayStreamError('OpenAI', 'received malformed JSON from the relay');
  }
  if (payload.error) throw createRelayStreamError('OpenAI', payload.error);
  if (payload.usage) callbacks.onOpenAIUsage?.(payload.usage);
  const choice = payload.choices?.[0];
  const message = choice?.message;
  let parts = 0;
  const text = extractText(message?.content);
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (reasoning) { callbacks.onReasoning(reasoning); parts++; }
  if (text) { callbacks.onContent(text); parts++; }
  if (message?.refusal) { callbacks.onRefusal?.(message.refusal); parts++; }
  const completedToolCalls = message?.tool_calls ?? [];
  validateToolCalls(completedToolCalls);
  const toolCalls = completedToolCalls.length;
  if (choice?.finish_reason) callbacks.onOpenAIFinishReason?.(choice.finish_reason);
  validateOpenAIFinishReason(choice?.finish_reason ?? undefined, toolCalls);
  for (const toolCall of completedToolCalls) callbacks.onToolCall(toolCall);
  parts += toolCalls;
  if (parts === 0) throw createIncompleteStreamError('OpenAI', 'empty-response');
}

function mergeToolCallDeltas(
  deltas: NonNullable<NonNullable<StreamChunk['choices']>[number]['delta']>['tool_calls'],
  pendingToolCalls: Map<number, ToolCall>,
  state: OpenAIStreamState,
): void {
  let pendingBytes = state.pendingToolBytes ?? [...pendingToolCalls.values()].reduce((bytes, call) => bytes + toolCallBytes(call), 0);
  const argumentEnds = state.pendingArgumentEnds ??= new Map<number, number>();
  for (const delta of deltas ?? []) {
    if (!Number.isSafeInteger(delta.index) || delta.index < 0) {
      throw createRelayStreamError('OpenAI', 'received an invalid tool call index');
    }
    const prior = pendingToolCalls.get(delta.index);
    if (!prior && pendingToolCalls.size >= MAX_PENDING_TOOL_CALLS) {
      throw createRelayStreamError('OpenAI', `pending tool calls exceed the local ${MAX_PENDING_TOOL_CALLS}-call buffer limit`);
    }
    const current: ToolCall = prior ? { ...prior, function: { ...prior.function } } : {
      id: delta.id ?? `call_${delta.index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    let argumentEnd = argumentEnds.get(delta.index)
      ?? (prior ? prior.function.arguments.charCodeAt(prior.function.arguments.length - 1) : NaN);
    let argumentBytesChange = 0;
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) {
      const nameDelta = delta.function.name;
      if (!current.function.name) current.function.name = nameDelta;
      else if (nameDelta === current.function.name || current.function.name.startsWith(nameDelta)) {
        // Ignore repeated complete snapshots and stale prefixes.
      } else if (nameDelta.startsWith(current.function.name)) current.function.name = nameDelta;
      else current.function.name += nameDelta;
    }
    const argumentsDelta: unknown = delta.function?.arguments;
    if (typeof argumentsDelta === 'string') {
      const merged = mergeToolArgumentDelta(current.function.arguments, argumentsDelta, argumentEnd);
      current.function.arguments = merged.value;
      argumentBytesChange = merged.bytesChange;
      argumentEnd = merged.end;
    } else if (argumentsDelta !== undefined && argumentsDelta !== null) {
      current.function.arguments = JSON.stringify(argumentsDelta);
      argumentBytesChange = Buffer.byteLength(current.function.arguments, 'utf8')
        - Buffer.byteLength(prior?.function.arguments ?? '', 'utf8');
      argumentEnd = current.function.arguments.charCodeAt(current.function.arguments.length - 1);
    }
    const idBytesChange = current.id === prior?.id ? 0
      : Buffer.byteLength(current.id, 'utf8') - Buffer.byteLength(prior?.id ?? '', 'utf8');
    const nameBytesChange = current.function.name === prior?.function.name ? 0
      : Buffer.byteLength(current.function.name, 'utf8') - Buffer.byteLength(prior?.function.name ?? '', 'utf8');
    const bytes = pendingBytes + idBytesChange + nameBytesChange + argumentBytesChange;
    if (bytes > MAX_PENDING_TOOL_BYTES) {
      throw createRelayStreamError('OpenAI', `pending tool calls exceed the local ${MAX_PENDING_TOOL_BYTES}-byte buffer limit`);
    }
    state.pendingToolBytes = pendingBytes = bytes;
    argumentEnds.set(delta.index, argumentEnd);
    pendingToolCalls.set(delta.index, current);
  }
}

function toolCallBytes(call: ToolCall): number {
  return Buffer.byteLength(call.id, 'utf8') + Buffer.byteLength(call.function.name, 'utf8')
    + Buffer.byteLength(call.function.arguments, 'utf8');
}

function mergeToolArgumentDelta(current: string, incoming: string, previousEnd: number): {
  value: string; bytesChange: number; end: number;
} {
  // Most events are small append-only deltas. Inspect the incoming fragment
  // first so ordinary appends never scan or flatten the accumulated string.
  if (current && incoming.trimStart().startsWith('{')) {
    if (current.trimStart().startsWith('{') && incoming.length > current.length && incoming.startsWith(current)) {
      return {
        value: incoming,
        bytesChange: Buffer.byteLength(incoming, 'utf8') - Buffer.byteLength(current, 'utf8'),
        end: incoming.charCodeAt(incoming.length - 1),
      };
    }
    if ((incoming === current || current.startsWith(incoming)) && isCompleteJsonObject(current)) {
      return { value: current, bytesChange: 0, end: previousEnd };
    }
  }
  // A JSON string can encode the two halves of a surrogate pair in separate
  // events. Joined UTF-8 then uses four bytes rather than two replacements (6).
  const first = incoming.charCodeAt(0);
  const joinedSurrogate = previousEnd >= 0xd800 && previousEnd <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  return {
    value: current + incoming,
    bytesChange: Buffer.byteLength(incoming, 'utf8') - (joinedSurrogate ? 2 : 0),
    end: incoming.length ? incoming.charCodeAt(incoming.length - 1) : previousEnd,
  };
}

function isCompleteJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function flushToolCalls(pending: Map<number, ToolCall>, callbacks: StreamCallbacks): number {
  const toolCalls = [...pending].sort(([a], [b]) => a - b).map(([, toolCall]) => toolCall);
  emitValidatedToolCalls(toolCalls, callbacks);
  pending.clear();
  return toolCalls.length;
}

function emitValidatedToolCalls(toolCalls: readonly ToolCall[], callbacks: StreamCallbacks): void {
  validateToolCalls(toolCalls);
  for (const toolCall of toolCalls) callbacks.onToolCall(toolCall);
}

function validateToolCalls(toolCalls: readonly ToolCall[]): void {
  for (const toolCall of toolCalls) validateToolCall(toolCall);
}

function validateToolCall(toolCall: ToolCall): void {
  if (!toolCall.id.trim() || !toolCall.function.name.trim()) {
    throw createRelayStreamError('OpenAI', 'received an incomplete tool call');
  }
  const argumentsValue = toolCall.function.arguments.trim();
  if (!argumentsValue) return;
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch {
    throw createRelayStreamError('OpenAI', 'received invalid tool call arguments');
  }
}

function validateOpenAIFinishReason(reason: string | undefined, toolCalls: number): void {
  if (reason === undefined) return;
  if (reason === 'stop') {
    if (toolCalls === 0) return;
    throw createRelayStreamError('OpenAI', 'finish_reason=stop was received with tool calls');
  }
  if (reason === 'tool_calls') {
    if (toolCalls > 0) return;
    throw createRelayStreamError('OpenAI', 'finish_reason=tool_calls was received without a valid tool call');
  }
  if (reason === 'length') {
    throw createRelayStreamError('OpenAI', 'the response reached its output token limit and may be incomplete');
  }
  if (reason === 'content_filter') {
    throw createRelayStreamError('OpenAI', 'the response was blocked by content filtering');
  }
  throw createRelayStreamError('OpenAI', `received unsupported finish_reason=${reason}`);
}

function parseOpenAIStreamJson(value: string): StreamChunk {
  try { return JSON.parse(value) as StreamChunk; }
  catch { throw createRelayStreamError('OpenAI', 'received malformed JSON from the relay'); }
}

function extractText(value: string | Array<{ text?: string }> | null | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value.map((part) => part.text ?? '').join('');
  return text || undefined;
}

function isStreamingUnsupported(status: number, statusText: string, body: string): boolean {
  if (![400, 404, 415, 422, 501].includes(status)) return false;
  const detail = `${statusText} ${body}`.toLowerCase();
  return /\b(stream|streaming|sse|event-stream)\b/.test(detail) &&
    /\b(unsupported|not supported|invalid|disabled|not allowed|unrecognized|unknown)\b/.test(detail);
}
