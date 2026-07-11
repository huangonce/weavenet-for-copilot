import * as vscode from 'vscode';
import type {
  ChatContentPart,
  ChatMessage,
  ClaudeContentBlock,
  ClaudeContentBlockText,
  ClaudeMessage,
  ClaudeToolDefinition,
  ToolDefinition,
  ToolCall,
} from '../relay/types';

const SYSTEM_ROLE = 3;

export interface ClaudeConversionOptions {
  supportsImageInput: boolean;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  supportsImageInput: boolean,
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    const contentParts: ChatContentPart[] = [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
        contentParts.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: stringifyToolResult(part.content),
        });
      } else if (supportsImageInput) {
        const imagePart = getImageDataPart(part);
        if (!imagePart) {
          continue;
        }
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imagePart.mimeType};base64,${Buffer.from(imagePart.data).toString('base64')}`,
            detail: 'auto',
            media_type: imagePart.mimeType,
          },
        });
      }
    }

    if (role === 'assistant') {
      if (textContent || toolCalls.length > 0) {
        result.push({
          role,
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (contentParts.length > 0) {
      result.push({
        role,
        content: supportsImageInput && contentParts.some((part) => part.type === 'image_url')
          ? contentParts
          : textContent,
      });
    }

    result.push(...toolResults);
  }

  return result;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ToolDefinition[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined
        ?? { type: 'object', properties: {} },
    },
  }));
}

function getImageDataPart(part: unknown): { mimeType: string; data: Uint8Array } | undefined {
  if (part instanceof vscode.LanguageModelDataPart) {
    return part.mimeType.startsWith('image/')
      ? { mimeType: part.mimeType, data: part.data }
      : undefined;
  }

  if (!part || typeof part !== 'object') {
    return undefined;
  }

  const candidate = part as Record<string, unknown>;
  const mimeType = firstString(candidate.mimeType, candidate.mime_type, candidate.mediaType);
  if (!mimeType?.startsWith('image/')) {
    return undefined;
  }

  const data = firstBytes(candidate.data, candidate.value, candidate.bytes);
  return data ? { mimeType, data } : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function firstBytes(...values: unknown[]): Uint8Array | undefined {
  for (const value of values) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  }
  return undefined;
}

export function convertClaudeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ClaudeConversionOptions,
): { system?: string | ClaudeContentBlockText[]; messages: ClaudeMessage[] } {
  const result: ClaudeMessage[] = [];
  const system: string[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
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

  const converted: ClaudeToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Record<string, unknown> | undefined,
  }));
  return converted;
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

function buildClaudeSystem(
  text: string,
): string | ClaudeContentBlockText[] | undefined {
  if (!text) {
    return undefined;
  }
  return text;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if ((role as number) === SYSTEM_ROLE) {
    return 'system';
  }
  return 'user';
}
