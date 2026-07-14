import type { CancellationToken } from 'vscode';
import * as vscode from 'vscode';
import type { StreamCallbacks } from './client';
import {
  createIncompleteStreamError,
  createRelayStreamError,
} from './errors';
import { throwIfNotOk, toAbortSignal } from './http';
import type {
  ClaudeContentBlock,
  ClaudeContentBlockText,
  ClaudeMessage,
  ClaudeRequest,
  ClaudeStreamEvent,
  ClaudeToolDefinition,
  ToolCall,
} from './types';

const SYSTEM_ROLE = 3;

export interface ClaudeConversionOptions {
  readonly supportsImageInput: boolean;
}

export interface ClaudeRequestOptions {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly anthropicVersion?: string;
}

export function convertClaudeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ClaudeConversionOptions,
): { system?: string | ClaudeContentBlockText[]; messages: ClaudeMessage[] } {
  const result: ClaudeMessage[] = [];
  const system: string[] = [];

  for (const message of messages) {
    const role = mapClaudeRole(message.role);
    const blocks: ClaudeContentBlock[] = [];
    let textContent = '';

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
        blocks.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({
          type: 'tool_use',
          id: part.callId,
          name: part.name,
          input: part.input ?? {},
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          content: stringifyToolResult(part.content),
        });
      } else if (options.supportsImageInput && part instanceof vscode.LanguageModelDataPart) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mimeType,
            data: Buffer.from(part.data).toString('base64'),
          },
        });
      }
    }

    if (role === 'system') {
      if (textContent) {
        system.push(textContent);
      }
      continue;
    }

    if (blocks.length === 0) {
      continue;
    }

    result.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: blocks,
    });
  }

  return {
    system: buildClaudeSystem(system.join('\n\n')),
    messages: mergeAdjacentClaudeMessages(result),
  };
}

export function convertClaudeTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ClaudeToolDefinition[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Record<string, unknown> | undefined,
  }));
}

export async function streamClaudeMessages(
  options: ClaudeRequestOptions,
  request: ClaudeRequest,
  callbacks: StreamCallbacks,
  token?: CancellationToken,
): Promise<void> {
  const response = await fetch(`${options.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'anthropic-version': options.anthropicVersion ?? '2023-06-01',
    },
    body: JSON.stringify(request),
    signal: toAbortSignal(token),
  });
  await throwIfNotOk(response);
  callbacks.onResponse?.('Claude', response.status, response.headers.get('content-type') ?? 'unknown');

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

    const event = parseClaudeStreamJson(trimmed.slice('data: '.length));
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
      callbacks.onStreamEnd?.('Claude', 'message_stop');
      return true;
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
  responseParts += flushToolCalls(toolBlocks, callbacks);
  throw createIncompleteStreamError(
    'Claude',
    responseParts === 0 ? 'missing-terminal-empty-response' : 'missing-terminal-event',
  );
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

function parseClaudeStreamJson(value: string): ClaudeStreamEvent {
  try {
    return JSON.parse(value) as ClaudeStreamEvent;
  } catch {
    throw createRelayStreamError('Claude', 'received malformed JSON from the relay');
  }
}

function stringifyToolResult(content: readonly vscode.LanguageModelToolResultPart['content'][number][]): string {
  let result = '';
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      result += part.value;
    }
  }
  return result || JSON.stringify(content);
}

function mergeAdjacentClaudeMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  const merged: ClaudeMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content = [
        ...toClaudeBlocks(previous.content),
        ...toClaudeBlocks(message.content),
      ];
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function toClaudeBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function buildClaudeSystem(text: string): string | ClaudeContentBlockText[] | undefined {
  return text || undefined;
}

function mapClaudeRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if ((role as number) === SYSTEM_ROLE) {
    return 'system';
  }
  return 'user';
}