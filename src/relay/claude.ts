import type { CancellationToken } from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { consumeSseChunk, fetchWithResponseTimeout, MAX_COMPLETE_RESPONSE_BYTES, readResponseText, readWithIdleTimeout, throwIfNotOk } from './http';
import { relayEndpointUrl } from './url';
import type { ClaudeRequest, ClaudeStreamEvent, StreamCallbacks, ToolCall } from './types';

const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export interface ClaudeRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly anthropicVersion?: string;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
}

export async function streamClaudeMessages(
  options: ClaudeRequestOptions,
  request: ClaudeRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  let currentRequest = request;
  let fallbackUsed = false;
  while (true) {
    const response = await fetchClaude(options, currentRequest, token);
    callbacks.onResponse?.('Claude', response.status, response.headers.get('content-type') ?? 'unknown');
    await throwIfNotOk(response, options.streamIdleTimeoutMs, token);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!currentRequest.stream || !contentType.includes('text/event-stream')) {
      await processClaudeFullResponse(response, callbacks, options.streamIdleTimeoutMs, token);
      callbacks.onStreamEnd?.('Claude', 'message_stop');
      return;
    }
    const outcome = await processClaudeStream(response, callbacks, options.streamIdleTimeoutMs, token);
    if (outcome.terminal) {
      callbacks.onStreamEnd?.('Claude', 'message_stop');
      return;
    }
    if (!fallbackUsed && !outcome.terminal && !outcome.started && outcome.parts === 0) {
      fallbackUsed = true;
      currentRequest = { ...request, stream: false };
      continue;
    }
    throw createIncompleteStreamError(
      'Claude',
      outcome.parts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
    );
  }
}

async function fetchClaude(
  options: ClaudeRequestOptions,
  request: ClaudeRequest,
  token?: CancellationToken,
): Promise<Response> {
  return fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: request.stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
      'anthropic-version': options.anthropicVersion ?? '2023-06-01',
    },
    body: JSON.stringify(request),
  }, options.requestTimeoutMs, token);
}

export async function processClaudeStream(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
): Promise<{ parts: number; started: boolean; terminal: boolean }> {
  if (!response.body) throw new Error('Relay returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const tools = new Map<number, ToolCall>();
  const state = { parts: 0, started: false };
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
        (line) => processClaudeSseLine(line, tools, callbacks, state),
        () => createRelayStreamError('Claude', `SSE event exceeds ${maxEventBytes} bytes`),
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
        (line) => processClaudeSseLine(line, tools, callbacks, state),
        () => createRelayStreamError('Claude', `SSE event exceeds ${maxEventBytes} bytes`),
      );
      buffer = consumed.buffer;
      terminal = consumed.stopped;
    }
    if (!terminal && buffer.trim()) terminal = processClaudeSseLine(buffer, tools, callbacks, state);
    state.parts += flushToolCalls(tools, callbacks);
    return { ...state, terminal };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function processClaudeSseLine(
  line: string,
  tools: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: { parts: number; started: boolean },
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
  const data = trimmed.slice('data:'.length).trim();
  if (!data || data === '[DONE]') return data === '[DONE]';
  const event = parseClaudeJson(data);
  if (event.type === 'error' || event.error) throw createRelayStreamError('Claude', event.error ?? event);
  if ((event.type === 'message_start'
    || event.type === 'message_delta'
    || event.type === 'content_block_start'
    || event.type === 'content_block_delta'
    || event.type === 'content_block_stop'
    || event.type === 'message_stop') && !state.started) {
    state.started = true;
    callbacks.onProcessingStarted?.('Claude');
  }
  if (event.message?.usage) callbacks.onClaudeUsage?.(event.message.usage, event.message.id);
  if (event.usage) callbacks.onClaudeUsage?.(event.usage, event.message?.id);
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const index = event.index ?? tools.size;
    const tool: PendingClaudeToolCall = {
      id: event.content_block.id ?? `toolu_${index}`,
      type: 'function',
      function: { name: event.content_block.name ?? '', arguments: '' },
      argumentsFallback: JSON.stringify(event.content_block.input ?? {}),
      sawArgumentDelta: false,
    };
    tools.set(index, tool);
  } else if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      callbacks.onContent(event.delta.text);
      state.parts++;
    } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      callbacks.onReasoning(event.delta.thinking);
      state.parts++;
    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
      const tool = tools.get(event.index ?? 0);
      if (tool) {
        const pending = tool as PendingClaudeToolCall;
        if (!pending.sawArgumentDelta) {
          tool.function.arguments = '';
          pending.sawArgumentDelta = true;
        }
        tool.function.arguments += event.delta.partial_json;
      }
    }
  } else if (event.type === 'content_block_stop') {
    const index = event.index ?? 0;
    const tool = tools.get(index);
    if (tool) {
      finalizeClaudeToolCall(tool);
      callbacks.onToolCall(tool);
      state.parts++;
      tools.delete(index);
    }
  } else if (event.type === 'message_stop') {
    return true;
  }
  return false;
}

export async function processClaudeFullResponse(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs = 60_000,
  token?: CancellationToken,
  maxBodyBytes = MAX_COMPLETE_RESPONSE_BYTES,
): Promise<void> {
  const body = await readResponseText(response, idleTimeoutMs, token, maxBodyBytes);
  const payload = parseClaudeJson(body);
  if (payload.error) throw createRelayStreamError('Claude', payload.error);
  if (payload.usage) callbacks.onClaudeUsage?.(payload.usage, payload.message?.id);
  let parts = 0;
  for (const block of payload.content ?? []) {
    if (block.type === 'text' && block.text) {
      callbacks.onContent(block.text);
      parts++;
    } else if (block.type === 'thinking' && block.thinking) {
      callbacks.onReasoning(block.thinking);
      parts++;
    } else if (block.type === 'tool_use') {
      callbacks.onToolCall({
        id: block.id ?? `toolu_${parts}`,
        type: 'function',
        function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
      });
      parts++;
    }
  }
  if (parts === 0) throw createIncompleteStreamError('Claude', 'empty-response');
}

function flushToolCalls(tools: Map<number, ToolCall>, callbacks: StreamCallbacks): number {
  let count = 0;
  for (const [, tool] of [...tools].sort(([a], [b]) => a - b)) {
    if (!tool.function.name) continue;
    finalizeClaudeToolCall(tool);
    callbacks.onToolCall(tool);
    count++;
  }
  tools.clear();
  return count;
}

type PendingClaudeToolCall = ToolCall & {
  argumentsFallback?: string;
  sawArgumentDelta?: boolean;
};

function finalizeClaudeToolCall(tool: ToolCall): void {
  const pending = tool as PendingClaudeToolCall;
  if (!pending.sawArgumentDelta && pending.argumentsFallback !== undefined) {
    tool.function.arguments = pending.argumentsFallback;
  }
  delete pending.argumentsFallback;
  delete pending.sawArgumentDelta;
}

function parseClaudeJson(value: string): ClaudeStreamEvent {
  try {
    return JSON.parse(value) as ClaudeStreamEvent;
  } catch {
    throw createRelayStreamError('Claude', 'received malformed JSON from the relay');
  }
}

