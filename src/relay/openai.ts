import type { CancellationToken } from 'vscode';
import type { StreamCallbacks } from './client';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { fetchWithResponseTimeout, readResponseText, readWithIdleTimeout, throwIfNotOk } from './http';
import type { ChatRequest, OpenAIFullResponse, StreamChunk, ToolCall } from './types';

export interface OpenAIRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
}

interface OpenAIStreamState {
  responseParts: number;
  started: boolean;
  sawFinishReason: boolean;
}

export async function streamOpenAIChatCompletion(
  options: OpenAIRequestOptions,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  let currentRequest = request;
  let fallbackUsed = false;
  while (true) {
    const response = await fetchOpenAI(options, currentRequest, token);
    callbacks.onResponse?.('OpenAI', response.status, response.headers.get('content-type') ?? 'unknown');
    if (!response.ok) {
      if (!fallbackUsed && currentRequest.stream && await isStreamingUnsupported(response)) {
        fallbackUsed = true;
        currentRequest = { ...request, stream: false, stream_options: undefined };
        continue;
      }
      await throwIfNotOk(response);
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
  token?: CancellationToken,
): Promise<Response> {
  // Never retry network-level POST failures. The upstream may already have
  // accepted the request, which could duplicate billing or tool execution.
  return fetchWithResponseTimeout(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...options.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }, options.requestTimeoutMs, token);
}

export async function processOpenAIStream(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs: number,
  token?: CancellationToken,
): Promise<{ responseParts: number; started: boolean; sawFinishReason: boolean; terminal: boolean }> {
  if (!response.body) throw new Error('Relay returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingToolCalls = new Map<number, ToolCall>();
  const state: OpenAIStreamState = { responseParts: 0, started: false, sawFinishReason: false };
  let buffer = '';
  let terminal = false;

  while (!terminal) {
    const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, token);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      terminal = processOpenAISseLine(line, pendingToolCalls, callbacks, state);
      if (terminal) break;
    }
  }
  buffer += decoder.decode();
  if (!terminal && buffer.trim()) {
    terminal = processOpenAISseLine(buffer, pendingToolCalls, callbacks, state);
  }
  state.responseParts += flushToolCalls(pendingToolCalls, callbacks);
  return { ...state, terminal };
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
  if (delta?.tool_calls) mergeToolCallDeltas(delta.tool_calls, pendingToolCalls);
  if (choice?.finish_reason) {
    state.sawFinishReason = true;
    state.responseParts += flushToolCalls(pendingToolCalls, callbacks);
  }
  return false;
}

export async function processOpenAIFullResponse(response: Response, callbacks: StreamCallbacks, idleTimeoutMs = 60_000, token?: CancellationToken): Promise<void> {
  const body = await readResponseText(response, idleTimeoutMs, token);
  let payload: OpenAIFullResponse;
  try {
    payload = JSON.parse(body) as OpenAIFullResponse;
  } catch {
    throw createRelayStreamError('OpenAI', 'received malformed JSON from the relay');
  }
  if (payload.error) throw createRelayStreamError('OpenAI', payload.error);
  if (payload.usage) callbacks.onOpenAIUsage?.(payload.usage);
  const message = payload.choices?.[0]?.message;
  let parts = 0;
  const text = extractText(message?.content);
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (reasoning) { callbacks.onReasoning(reasoning); parts++; }
  if (text) { callbacks.onContent(text); parts++; }
  for (const toolCall of message?.tool_calls ?? []) {
    callbacks.onToolCall(toolCall);
    parts++;
  }
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
      current.function.arguments += argumentsDelta;
    } else if (argumentsDelta !== undefined && argumentsDelta !== null) {
      current.function.arguments = JSON.stringify(argumentsDelta);
    }
    pendingToolCalls.set(delta.index, current);
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

async function isStreamingUnsupported(response: Response): Promise<boolean> {
  if (![400, 404, 415, 422, 501].includes(response.status)) return false;
  const detail = `${response.statusText} ${await response.clone().text().catch(() => '')}`.toLowerCase();
  return /\b(stream|streaming|sse|event-stream)\b/.test(detail) &&
    /\b(unsupported|not supported|invalid|disabled|not allowed|unrecognized|unknown)\b/.test(detail);
}