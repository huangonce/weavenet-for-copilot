import type { CancellationToken } from 'vscode';
import type { StreamCallbacks } from './client';
import {
  createIncompleteStreamError,
  createRelayStreamError,
} from './errors';
import { throwIfNotOk, toAbortSignal } from './http';
import type { ChatRequest, StreamChunk, ToolCall } from './types';

export interface OpenAIRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
}

export async function streamOpenAIChatCompletion(
  options: OpenAIRequestOptions,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: toAbortSignal(token),
  });
  await throwIfNotOk(response);
  callbacks.onResponse?.('OpenAI', response.status, response.headers.get('content-type') ?? 'unknown');

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
      callbacks.onStreamEnd?.('OpenAI', '[DONE]');
      return true;
    }
    if (!trimmed.startsWith('data: ')) {
      return false;
    }

    const chunk = parseOpenAIStreamJson(trimmed.slice('data: '.length));
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
  callbacks.onStreamEnd?.('OpenAI', 'finish_reason');
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

function parseOpenAIStreamJson(value: string): StreamChunk {
  try {
    return JSON.parse(value) as StreamChunk;
  } catch {
    throw createRelayStreamError('OpenAI', 'received malformed JSON from the relay');
  }
}