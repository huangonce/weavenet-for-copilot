import * as vscode from 'vscode';
import type {
  ChatContentPart,
  ChatMessage,
  ToolDefinition,
  ToolCall,
} from '../relay/types';
import { sanitizeJsonSchema } from '../relay/schema';

const SYSTEM_ROLE = 3;

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
      parameters: sanitizeJsonSchema(tool.inputSchema) ?? { type: 'object', properties: {} },
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

function stringifyToolResult(content: readonly vscode.LanguageModelToolResultPart['content'][number][]): string {
  let result = '';
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      result += part.value;
    }
  }
  return result || JSON.stringify(content);
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
