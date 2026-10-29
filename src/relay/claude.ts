import { randomUUID } from 'node:crypto';
import type { CancellationToken } from 'vscode';
import { ClaudeReplayCollector } from './claudeReplay';
import { MAX_PROTOCOL_REPLAY_ITEMS, ReplayBudget } from './replayState';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { fetchWithResponseTimeout, MAX_COMPLETE_RESPONSE_BYTES, MAX_SSE_EVENT_BYTES, readResponseText, readSseStream, responseDiagnosticsMetadata, throwIfNotOk } from './http';
import { relayEndpointUrl } from './url';
import type { ClaudeRequest, ClaudeStreamEvent, StreamCallbacks, ToolCall } from './types';

interface ClaudeParseState {
  parts: number;
  started: boolean;
  replay?: ClaudeReplayCollector;
  stopReason?: string;
  finished?: boolean;
  openBlocks?: Set<number>;
  toolBudget?: ReplayBudget;
}

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
  // A successful but empty stream is still an accepted POST. Retrying it as
  // non-streaming could duplicate upstream work or billing.
  const clientRequestId = randomUUID();
  const response = await fetchClaude(options, request, callbacks, clientRequestId, token);
  callbacks.onResponse?.('Claude', response.status, response.headers.get('content-type') ?? 'unknown', {
    ...responseDiagnosticsMetadata(response), clientRequestId,
  });
  await throwIfNotOk(response, options.streamIdleTimeoutMs, token);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!request.stream || !contentType.includes('text/event-stream')) {
    await processClaudeFullResponse(response, callbacks, options.streamIdleTimeoutMs, token);
    callbacks.onStreamEnd?.('Claude', 'message_stop');
    return;
  }
  const outcome = await processClaudeStream(response, callbacks, options.streamIdleTimeoutMs, token);
  if (outcome.terminal) {
    if (outcome.parts === 0) {
      throw createIncompleteStreamError('Claude', 'empty-response');
    }
    callbacks.onStreamEnd?.('Claude', 'message_stop');
    return;
  }
  throw createIncompleteStreamError(
    'Claude',
    outcome.parts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
  );
}

async function fetchClaude(
  options: ClaudeRequestOptions,
  request: ClaudeRequest,
  callbacks: StreamCallbacks,
  clientRequestId: string,
  token?: CancellationToken,
): Promise<Response> {
  // API version 2026-10-21 removed sampling parameters, including their defaults.
  // Apply this at the wire boundary so direct callers obey the same contract.
  const body = JSON.stringify(options.anthropicVersion && options.anthropicVersion >= '2026-10-21'
    ? { ...request, temperature: undefined, top_p: undefined } : request);
  callbacks.onRequest?.('Claude', { clientRequestId, bodyBytes: Buffer.byteLength(body),
    clientRequestIdSent: false, attempt: 1, stream: request.stream });
  return fetchWithResponseTimeout(relayEndpointUrl(options.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: request.stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
      'anthropic-version': options.anthropicVersion ?? '2023-06-01',
    },
    body,
  }, options.requestTimeoutMs, token, diagnostics => callbacks.onRequestSettled?.('Claude', {
    clientRequestId, ...diagnostics,
  }));
}

export async function processClaudeStream(
  response: Response,
  callbacks: StreamCallbacks,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
): Promise<{ parts: number; started: boolean; terminal: boolean }> {
  const tools = new Map<number, ToolCall>();
  const state: ClaudeParseState = { parts: 0, started: false };
  const terminal = await readSseStream(response, {
    protocol: 'Claude', idleTimeoutMs, token, maxEventBytes,
    onEventData: (data) => processClaudeSseData(data, tools, callbacks, state),
  });
  return { parts: state.parts, started: state.started, terminal };
}

export function processClaudeSseLine(
  line: string,
  tools: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: ClaudeParseState,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
  const data = trimmed.slice('data:'.length).trim();
  return processClaudeSseData(data, tools, callbacks, state);
}

function processClaudeSseData(
  data: string,
  tools: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
  state: ClaudeParseState,
): boolean {
  if (!data) return false;
  if (state.finished) return true;
  if (data === '[DONE]') return finishClaudeStream(tools, callbacks, state);
  const event = parseClaudeJson(data);
  if (callbacks.onClaudeAssistantContent) {
    state.replay ??= new ClaudeReplayCollector();
    state.replay.consume(event);
  }
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
  // `message_start` carries usage on `message.usage`; `message_delta.usage`
  // contains cumulative counts, not increments. Pick whichever this event has
  // so a single event can never trigger the usage callback twice.
  if (event.type === 'message_delta' && event.delta?.stop_reason) {
    if (state.stopReason && state.stopReason !== event.delta.stop_reason) {
      throw createRelayStreamError('Claude', 'received inconsistent stop reasons');
    }
    state.stopReason = event.delta.stop_reason;
    callbacks.onClaudeStopReason?.(state.stopReason);
  }
  const usage = event.usage ?? event.message?.usage;
  if (usage) callbacks.onClaudeUsage?.(usage, event.message?.id);
  if (event.type === 'content_block_start' || event.type === 'content_block_delta') {
    const open = state.openBlocks ??= new Set();
    const index = event.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PROTOCOL_REPLAY_ITEMS) {
      throw createRelayStreamError('Claude', 'received an invalid content block index');
    }
    open.add(index);
  } else if (event.type === 'content_block_stop') {
    state.openBlocks?.delete(event.index ?? 0);
  }
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block?.type === 'text' && block.text) { callbacks.onContent(block.text); state.parts++; }
    if (block?.type === 'thinking' && block.thinking) { callbacks.onReasoning(block.thinking); state.parts++; }
    if (block?.type === 'redacted_thinking') { callbacks.onReasoning('[Redacted thinking]'); state.parts++; }
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const index = event.index ?? tools.size;
    const tool: PendingClaudeToolCall = {
      id: event.content_block.id ?? '',
      type: 'function',
      function: { name: event.content_block.name ?? '', arguments: '' },
      argumentsFallback: JSON.stringify(event.content_block.input === undefined ? {} : event.content_block.input),
      sawArgumentDelta: false,
      stopped: false,
    };
    if (tools.has(index)) throw createRelayStreamError('Claude', 'received a repeated tool block index');
    if (tools.size >= MAX_PROTOCOL_REPLAY_ITEMS) throw createRelayStreamError('Claude', 'received too many tool calls');
    (state.toolBudget ??= new ReplayBudget()).reserveJson(tool);
    tools.set(index, tool);
  } else if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      callbacks.onContent(event.delta.text);
      state.parts++;
    } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      callbacks.onReasoning(event.delta.thinking);
      state.parts++;
    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
      const tool = tools.get(event.index ?? 0);
      if (tool) {
        const pending = tool as PendingClaudeToolCall;
        if (pending.stopped) throw createRelayStreamError('Claude', 'received tool input after its block ended');
        if (!pending.sawArgumentDelta) {
          tool.function.arguments = '';
          pending.sawArgumentDelta = true;
        }
        (state.toolBudget ??= new ReplayBudget()).reserve(event.delta.partial_json);
        tool.function.arguments += event.delta.partial_json;
      }
    }
  } else if (event.type === 'content_block_stop') {
    const index = event.index ?? 0;
    const tool = tools.get(index);
    if (tool) (tool as PendingClaudeToolCall).stopped = true;
  } else if (event.type === 'message_stop') {
    return finishClaudeStream(tools, callbacks, state);
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
  if (payload.stop_reason) callbacks.onClaudeStopReason?.(payload.stop_reason);
  const replay = callbacks.onClaudeAssistantContent ? new ClaudeReplayCollector() : undefined;
  const tools = new Map<number, ToolCall>();
  let parts = 0;
  let blockIndex = 0;
  for (const block of payload.content ?? []) {
    const index = blockIndex++;
    replay?.consume({ type: 'content_block_start', index, content_block: block });
    replay?.consume({ type: 'content_block_stop', index });
    if (block.type === 'redacted_thinking') { callbacks.onReasoning('[Redacted thinking]'); parts++; }
    if (block.type === 'text' && block.text) {
      callbacks.onContent(block.text);
      parts++;
    } else if (block.type === 'thinking' && block.thinking) {
      callbacks.onReasoning(block.thinking);
      parts++;
    } else if (block.type === 'tool_use') {
      tools.set(index, {
        id: block.id ?? '',
        type: 'function',
        function: { name: block.name ?? '', arguments: JSON.stringify(block.input === undefined ? {} : block.input) },
        stopped: true,
      } as PendingClaudeToolCall);
    }
  }
  const calls = completedClaudeTools(tools, payload.stop_reason);
  const content = replay?.finish(isClaudeTruncated(payload.stop_reason));
  parts += calls.length;
  if (parts === 0) throw createIncompleteStreamError('Claude', 'empty-response');
  if (content) callbacks.onClaudeAssistantContent?.(content);
  for (const call of calls) callbacks.onToolCall(call);
}

function finishClaudeStream(tools: Map<number, ToolCall>, callbacks: StreamCallbacks, state: ClaudeParseState): true {
  if (state.stopReason === 'tool_use' && state.openBlocks?.size) {
    throw createRelayStreamError('Claude', 'received an incomplete content block before tool use');
  }
  const calls = completedClaudeTools(tools, state.stopReason);
  const content = state.replay?.finish(isClaudeTruncated(state.stopReason));
  if (content) callbacks.onClaudeAssistantContent?.(content);
  for (const call of calls) callbacks.onToolCall(call);
  state.parts += calls.length;
  state.finished = true;
  tools.clear();
  return true;
}

export function isClaudeTruncated(stopReason: string | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded' || stopReason === 'pause_turn';
}

function completedClaudeTools(tools: Map<number, ToolCall>, stopReason: string | undefined): ToolCall[] {
  // A closed content block can still contain truncated input. Wait for the
  // message stop reason before parsing or making any tool executable.
  if (isClaudeTruncated(stopReason)) return [];
  if (tools.size && stopReason !== 'tool_use') {
    throw createRelayStreamError('Claude', 'tool calls ended without stop_reason=tool_use');
  }
  if (!tools.size && stopReason === 'tool_use') {
    throw createRelayStreamError('Claude', 'stop_reason=tool_use was received without a tool call');
  }
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const [, tool] of [...tools].sort(([a], [b]) => a - b)) {
    if (!(tool as PendingClaudeToolCall).stopped || typeof tool.id !== 'string' || !tool.id.trim()
      || typeof tool.function.name !== 'string' || !tool.function.name.trim()) {
      throw createRelayStreamError('Claude', 'received an incomplete tool call');
    }
    finalizeClaudeToolCall(tool);
    try {
      const input: unknown = JSON.parse(tool.function.arguments);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object');
    } catch {
      throw createRelayStreamError('Claude', 'received invalid tool call arguments');
    }
    if (ids.has(tool.id)) throw createRelayStreamError('Claude', 'received duplicate tool call IDs');
    ids.add(tool.id);
    calls.push(tool);
  }
  return calls;
}

type PendingClaudeToolCall = ToolCall & {
  argumentsFallback?: string;
  sawArgumentDelta?: boolean;
  stopped?: boolean;
};

function finalizeClaudeToolCall(tool: ToolCall): void {
  const pending = tool as PendingClaudeToolCall;
  if (!pending.sawArgumentDelta && pending.argumentsFallback !== undefined) {
    tool.function.arguments = pending.argumentsFallback;
  }
  delete pending.argumentsFallback;
  delete pending.sawArgumentDelta;
  delete pending.stopped;
}

function parseClaudeJson(value: string): ClaudeStreamEvent {
  try {
    return JSON.parse(value) as ClaudeStreamEvent;
  } catch {
    throw createRelayStreamError('Claude', 'received malformed JSON from the relay');
  }
}
