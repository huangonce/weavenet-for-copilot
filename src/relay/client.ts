import type { CancellationToken } from 'vscode';
import type {
  ChatRequest,
  ClaudeRequest,
  ClaudeStreamEvent,
  ClaudeUsage,
  ModelsResponse,
  OpenAIUsage,
  StreamChunk,
  ToolCall,
} from './types';
import {
  createIncompleteStreamError,
  createRelayRequestError,
  createRelayStreamError,
} from './errors';

export interface RelayClientOptions {
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string>;
  authScheme?: 'bearer' | 'x-api-key';
  anthropicVersion?: string;
}

export interface StreamCallbacks {
  onContent(text: string): void;
  onReasoning(text: string): void;
  onToolCall(toolCall: ToolCall): void;
  onOpenAIUsage?(usage: OpenAIUsage): void;
  onClaudeUsage?(usage: ClaudeUsage, responseId?: string): void;
}

export class RelayClient {
  constructor(private readonly options: RelayClientOptions) {}

  async listModels(token?: CancellationToken): Promise<ModelsResponse> {
    const response = await fetch(`${this.options.baseUrl}/models`, {
      headers: this.headers(),
      signal: toAbortSignal(token),
    });
    await throwIfNotOk(response);
    return (await response.json()) as ModelsResponse;
  }

  async streamChatCompletion(
    request: ChatRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
  ): Promise<void> {
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: toAbortSignal(token),
    });
    await throwIfNotOk(response);

    if (!response.body) {
      throw new Error('Relay returned an empty response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const pendingToolCalls = new Map<number, ToolCall>();
    let buffer = '';
    let sawFinishReason = false;
    let responseParts = 0;

    const processLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) {
        return false;
      }
      if (trimmed === 'data: [DONE]') {
        responseParts += flushToolCalls(pendingToolCalls, callbacks);
        if (responseParts === 0) {
          throw createIncompleteStreamError('OpenAI', 'empty-response');
        }
        return true;
      }
      if (!trimmed.startsWith('data: ')) {
        return false;
      }

      const chunk = parseStreamJson(trimmed.slice('data: '.length), 'OpenAI') as StreamChunk;
      if (chunk.error) {
        throw createRelayStreamError('OpenAI', chunk.error.message);
      }
      if (chunk.usage) {
        callbacks.onOpenAIUsage?.(chunk.usage);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) {
        callbacks.onReasoning(delta.reasoning_content);
        responseParts++;
      }
      if (delta?.content) {
        callbacks.onContent(delta.content);
        responseParts++;
      }
      if (delta?.tool_calls) {
        mergeToolCallDeltas(delta.tool_calls, pendingToolCalls);
      }
      if (choice?.finish_reason) {
        sawFinishReason = true;
        responseParts += flushToolCalls(pendingToolCalls, callbacks);
      }
      return false;
    };

    while (true) {
      if (token?.isCancellationRequested) {
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (processLine(line)) {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() && processLine(buffer)) {
      return;
    }
    responseParts += flushToolCalls(pendingToolCalls, callbacks);
    if (!sawFinishReason) {
      throw createIncompleteStreamError(
        'OpenAI',
        responseParts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
      );
    }
    if (responseParts === 0) {
      throw createIncompleteStreamError('OpenAI', 'empty-response');
    }
  }

  async streamClaudeMessages(
    request: ClaudeRequest,
    callbacks: StreamCallbacks,
    token?: CancellationToken,
  ): Promise<void> {
    const response = await fetch(`${this.options.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
        'anthropic-version': this.options.anthropicVersion ?? '2023-06-01',
      },
      body: JSON.stringify(request),
      signal: toAbortSignal(token),
    });
    await throwIfNotOk(response);

    if (!response.body) {
      throw new Error('Relay returned an empty response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolBlocks = new Map<number, ToolCall>();
    let buffer = '';
    let responseParts = 0;

    const processLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) {
        return false;
      }

      const event = parseStreamJson(trimmed.slice('data: '.length), 'Claude') as ClaudeStreamEvent;
      if (event.type === 'error' || event.error) {
        throw createRelayStreamError('Claude', event.error?.message);
      }
      if (event.type === 'message_start' && event.message?.usage) {
        callbacks.onClaudeUsage?.(event.message.usage, event.message.id);
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolBlocks.set(event.index ?? 0, {
          id: event.content_block.id ?? `toolu_${event.index ?? 0}`,
          type: 'function',
          function: {
            name: event.content_block.name ?? '',
            arguments: '',
          },
        });
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          callbacks.onContent(event.delta.text);
          responseParts++;
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          callbacks.onReasoning(event.delta.thinking);
          responseParts++;
        } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
          const toolCall = toolBlocks.get(event.index ?? 0);
          if (toolCall) {
            toolCall.function.arguments += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_stop') {
        const toolCall = toolBlocks.get(event.index ?? 0);
        if (toolCall) {
          callbacks.onToolCall(toolCall);
          responseParts++;
          toolBlocks.delete(event.index ?? 0);
        }
      } else if (event.type === 'message_stop') {
        responseParts += flushToolCalls(toolBlocks, callbacks);
        if (responseParts === 0) {
          throw createIncompleteStreamError('Claude', 'empty-response');
        }
        return true;
      }
      return false;
    };

    while (true) {
      if (token?.isCancellationRequested) {
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (processLine(line)) {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() && processLine(buffer)) {
      return;
    }
    responseParts += flushToolCalls(toolBlocks, callbacks);
    throw createIncompleteStreamError(
      'Claude',
      responseParts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
    );
  }

  private headers(): Record<string, string> {
    if (this.options.authScheme === 'x-api-key') {
      return {
        ...this.options.requestHeaders,
        'x-api-key': this.options.apiKey,
      };
    }

    return {
      ...this.options.requestHeaders,
      Authorization: `Bearer ${this.options.apiKey}`,
    };
  }
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const text = await response.text().catch(() => '');
  throw createRelayRequestError(
    response.status,
    response.statusText,
    response.headers.get('content-type') ?? '',
    text,
  );
}

function mergeToolCallDeltas(
  deltas: NonNullable<NonNullable<StreamChunk['choices']>[number]['delta']>['tool_calls'],
  pendingToolCalls: Map<number, ToolCall>,
): void {
  for (const delta of deltas ?? []) {
    let current = pendingToolCalls.get(delta.index);
    if (!current && delta.id) {
      current = {
        id: delta.id,
        type: 'function',
        function: {
          name: '',
          arguments: '',
        },
      };
      pendingToolCalls.set(delta.index, current);
    }
    if (!current) {
      continue;
    }
    current.function.name += delta.function?.name ?? '';
    current.function.arguments += delta.function?.arguments ?? '';
  }
}

function flushToolCalls(
  pendingToolCalls: Map<number, ToolCall>,
  callbacks: StreamCallbacks,
): number {
  let count = 0;
  for (const toolCall of pendingToolCalls.values()) {
    callbacks.onToolCall(toolCall);
    count++;
  }
  pendingToolCalls.clear();
  return count;
}

function parseStreamJson(value: string, protocol: 'OpenAI' | 'Claude'): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw createRelayStreamError(protocol, 'received malformed JSON from the relay');
  }
}

function toAbortSignal(token: CancellationToken | undefined): AbortSignal | undefined {
  if (!token) {
    return undefined;
  }

  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
