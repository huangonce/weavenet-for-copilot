import type { CancellationToken } from 'vscode';
import * as vscode from 'vscode';
import { createIncompleteStreamError, createRelayStreamError } from './errors';
import { consumeSseChunk, fetchWithResponseTimeout, MAX_COMPLETE_RESPONSE_BYTES, readResponseText, readWithIdleTimeout, throwIfNotOk } from './http';
import { sanitizeJsonSchema } from './schema';
import { relayEndpointUrl } from './url';
import type {
  ClaudeCacheControl, ClaudeContentBlock, ClaudeContentBlockText, ClaudeMessage,
  ClaudeRequest, ClaudeStreamEvent, ClaudeToolDefinition, StreamCallbacks, ToolCall,
} from './types';

const SYSTEM_ROLE = 3;
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export interface ClaudeConversionOptions {
  readonly supportsImageInput: boolean;
  readonly promptCaching?: boolean;
  readonly cacheTTL?: '5m' | '1h';
}

export interface ClaudeRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly anthropicVersion?: string;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
}

export function convertClaudeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ClaudeConversionOptions,
): { system?: string | ClaudeContentBlockText[]; messages: ClaudeMessage[] } {
  const result: ClaudeMessage[] = [];
  const system: string[] = [];
  const pendingToolUseIds = new Set<string>();
  let pendingToolUseMessage: ClaudeMessage | undefined;

  const discardPendingToolUses = () => {
    if (!pendingToolUseMessage || pendingToolUseIds.size === 0) {
      pendingToolUseIds.clear();
      pendingToolUseMessage = undefined;
      return;
    }
    const content = toBlocks(pendingToolUseMessage.content).filter((block) =>
      block.type !== 'tool_use' || !pendingToolUseIds.has(block.id));
    pendingToolUseMessage.content = content;
    if (content.length === 0) {
      const index = result.indexOf(pendingToolUseMessage);
      if (index >= 0) result.splice(index, 1);
    }
    pendingToolUseIds.clear();
    pendingToolUseMessage = undefined;
  };

  for (const message of messages) {
    const role = mapClaudeRole(message.role);
    const blocks: ClaudeContentBlock[] = [];
    let textContent = '';
    let interruptsToolChain = false;
    if (role === 'assistant' || role === 'system') discardPendingToolUses();
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
        blocks.push({ type: 'text', text: part.value });
        interruptsToolChain = role === 'user';
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input ?? {} });
        if (role === 'assistant') pendingToolUseIds.add(part.callId);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (role === 'user' && pendingToolUseIds.has(part.callId)) {
          blocks.push({ type: 'tool_result', tool_use_id: part.callId, content: stringifyToolResult(part.content) });
          pendingToolUseIds.delete(part.callId);
        }
      } else if (options.supportsImageInput && part instanceof vscode.LanguageModelDataPart) {
        const mediaType = normalizeClaudeImageMediaType(part.mimeType);
        if (mediaType) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: Buffer.from(part.data).toString('base64') },
          });
          interruptsToolChain = role === 'user';
        }
      }
    }
    if (interruptsToolChain) discardPendingToolUses();
    if (role === 'system') {
      if (textContent) system.push(textContent);
    } else if (blocks.length) {
      result.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
      if (role === 'assistant' && pendingToolUseIds.size > 0) pendingToolUseMessage = result.at(-1);
      if (role === 'user' && pendingToolUseIds.size === 0) pendingToolUseMessage = undefined;
    }
  }
  discardPendingToolUses();
  const merged = mergeAdjacentClaudeMessages(result);
  if (options.promptCaching) applyLastTwoUserCacheControl(merged, options.cacheTTL ?? '5m');
  return {
    system: buildClaudeSystem(system.join('\n\n'), options.promptCaching, options.cacheTTL),
    messages: merged,
  };
}

export function convertClaudeTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  promptCaching = false,
  cacheTTL: '5m' | '1h' = '5m',
): ClaudeToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  const mapped: ClaudeToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: sanitizeJsonSchema(tool.inputSchema) ?? { type: 'object', properties: {} },
  }));
  if (promptCaching) mapped[mapped.length - 1].cache_control = makeCacheControl(cacheTTL);
  return mapped;
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

export function normalizeClaudeImageMediaType(value: string): string | undefined {
  const normalized = value.trim().toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : value.trim().toLowerCase();
  return CLAUDE_IMAGE_TYPES.has(normalized) ? normalized : undefined;
}

export function clampClaudeTemperature(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.min(1, value));
}

export function applyLastTwoUserCacheControl(messages: ClaudeMessage[], ttl: '5m' | '1h'): void {
  let count = 0;
  for (let index = messages.length - 1; index >= 0 && count < 2; index--) {
    const message = messages[index];
    if (message.role !== 'user' || typeof message.content === 'string' || !message.content.length) continue;
    const last = message.content.length - 1;
    message.content[last] = {
      ...message.content[last],
      cache_control: makeCacheControl(ttl),
    } as ClaudeContentBlock;
    count++;
  }
}

function buildClaudeSystem(
  text: string,
  caching = false,
  ttl: '5m' | '1h' = '5m',
): string | ClaudeContentBlockText[] | undefined {
  if (!text) return undefined;
  return caching ? [{ type: 'text', text, cache_control: makeCacheControl(ttl) }] : text;
}

function makeCacheControl(ttl: '5m' | '1h'): ClaudeCacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
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

function stringifyToolResult(content: readonly vscode.LanguageModelToolResultPart['content'][number][]): string {
  let result = '';
  for (const part of content) if (part instanceof vscode.LanguageModelTextPart) result += part.value;
  return result || JSON.stringify(content);
}

function mergeAdjacentClaudeMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const merged: ClaudeMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content = [...toBlocks(previous.content), ...toBlocks(message.content)];
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function toBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function mapClaudeRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  return (role as number) === SYSTEM_ROLE ? 'system' : 'user';
}

