import { randomUUID } from 'node:crypto';
import type { CancellationToken } from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { consumeSseChunk, fetchWithResponseTimeout, MAX_COMPLETE_RESPONSE_BYTES, readRelayErrorResponse, readResponseText, readWithIdleTimeout, responseDiagnosticsMetadata } from './http';
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
}

const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export async function streamOpenAIChatCompletion(
  options: OpenAIRequestOptions,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  let currentRequest = request;
  let fallbackUsed = false;
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
      if (!fallbackUsed && currentRequest.stream && isStreamingUnsupported(response.status, response.statusText, failure.body)) {
        fallbackUsed = true;
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
      callbacks.onStreamEnd?.('OpenAI', outcome.terminal ? '[DONE]' : 'finish_reason');
      return;
    }
    if (!fallbackUsed && !outcome.terminal && !outcome.started && outcome.responseParts === 0) {
      fallbackUsed = true;
      currentRequest = { ...request, stream: false, stream_options: undefined };
      continue;
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
): Promise<{ responseParts: number; started: boolean; sawFinishReason: boolean; terminal: boolean }> {
  if (!response.body) throw new Error('Relay returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingToolCalls = new Map<number, ToolCall>();
  const state: OpenAIStreamState = { responseParts: 0, started: false, sawFinishReason: false };
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
        (line) => processOpenAISseLine(line, pendingToolCalls, callbacks, state),
        () => createRelayStreamError('OpenAI', `SSE event exceeds ${maxEventBytes} bytes`),
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
        (line) => processOpenAISseLine(line, pendingToolCalls, callbacks, state),
        () => createRelayStreamError('OpenAI', `SSE event exceeds ${maxEventBytes} bytes`),
      );
      buffer = consumed.buffer;
      terminal = consumed.stopped;
    }
    if (!terminal && buffer.trim()) {
      terminal = processOpenAISseLine(buffer, pendingToolCalls, callbacks, state);
    }
    state.responseParts += flushToolCalls(pendingToolCalls, callbacks);
    return { ...state, terminal };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
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
  if (delta?.tool_calls) mergeToolCallDeltas(delta.tool_calls, pendingToolCalls);
  if (choice?.finish_reason) {
    state.sawFinishReason = true;
    state.finishReason = choice.finish_reason;
    callbacks.onOpenAIFinishReason?.(choice.finish_reason);
    state.responseParts += flushToolCalls(pendingToolCalls, callbacks);
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
  for (const toolCall of message?.tool_calls ?? []) {
    callbacks.onToolCall(toolCall);
    parts++;
  }
  if (choice?.finish_reason) callbacks.onOpenAIFinishReason?.(choice.finish_reason);
  if (parts === 0) throw createIncompleteStreamError('OpenAI', 'empty-response');
}

function mergeToolCallDeltas(
  deltas: NonNullable<NonNullable<StreamChunk['choices']>[number]['delta']>['tool_calls'],
  pendingToolCalls: Map<number, ToolCall>,
): void {
  for (const delta of deltas ?? []) {
    const current = pendingToolCalls.get(delta.index) ?? {
      id: delta.id ?? `call_${delta.index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
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
      current.function.arguments = mergeToolArgumentDelta(current.function.arguments, argumentsDelta);
    } else if (argumentsDelta !== undefined && argumentsDelta !== null) {
      current.function.arguments = JSON.stringify(argumentsDelta);
    }
    pendingToolCalls.set(delta.index, current);
  }
}

function mergeToolArgumentDelta(current: string, incoming: string): string {
  if (!current) return incoming;
  const currentLooksLikeObject = current.trimStart().startsWith('{');
  const incomingLooksLikeObject = incoming.trimStart().startsWith('{');
  if (currentLooksLikeObject && incomingLooksLikeObject && incoming.length > current.length && incoming.startsWith(current)) {
    return incoming;
  }
  if (incomingLooksLikeObject && (incoming === current || current.startsWith(incoming)) && isCompleteJsonObject(current)) {
    return current;
  }
  return current + incoming;
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
  let count = 0;
  for (const [, toolCall] of [...pending].sort(([a], [b]) => a - b)) {
    if (!toolCall.function.name) continue;
    callbacks.onToolCall(toolCall);
    count++;
  }
  pending.clear();
  return count;
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

