import * as vscode from 'vscode';
import type {
  ChatContentPart,
  ChatMessage,
  ClaudeCacheControl,
  ClaudeContentBlock,
  ClaudeContentBlockText,
  ClaudeMessage,
  ClaudeToolDefinition,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesToolDefinition,
  ToolDefinition,
  ToolCall,
} from '../relay/types';
import { sanitizeJsonSchema, toStrictJsonSchema } from '../relay/schema';

const SYSTEM_ROLE = 3;
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  supportsImageInput: boolean,
  supportsDeveloperRole = false,
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role, supportsDeveloperRole);
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
  enableStrict = false,
): ToolDefinition[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => {
    const parameters = sanitizeJsonSchema(tool.inputSchema) ?? { type: 'object', properties: {} };
    const strictParameters = enableStrict ? toStrictJsonSchema(parameters) : undefined;
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: strictParameters ?? parameters,
        ...(strictParameters ? { strict: true as const } : {}),
      },
    };
  });
}

/**
 * Converts VS Code chat messages to OpenAI Responses API input items.
 * Assistant tool calls are preserved as top-level `function_call` items (not
 * nested content parts, which only accept input_text/input_image/etc.) so the
 * following `function_call_output` items keep a matching call_id; dropping
 * them would leave the call_id dangling and can make strict relays reject the
 * history with a 400.
 */
export function convertResponsesInput(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  supportsImageInput: boolean,
): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = [];

  for (const message of messages) {
    const role = mapResponsesRole(message.role);
    const contentParts: ResponsesInputContentPart[] = [];
    let textContent = '';
    const functionCalls: ResponsesInputItem[] = [];
    const toolResults: ResponsesInputItem[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
        contentParts.push({ type: 'input_text', text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        functionCalls.push({
          type: 'function_call',
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          type: 'function_call_output',
          call_id: part.callId,
          output: stringifyToolResult(part.content),
        });
      } else if (supportsImageInput) {
        const imagePart = getImageDataPart(part);
        if (!imagePart) {
          continue;
        }
        contentParts.push({
          type: 'input_image',
          image_url: `data:${imagePart.mimeType};base64,${Buffer.from(imagePart.data).toString('base64')}`,
          detail: 'auto',
        });
      }
    }

    if (role === 'assistant') {
      if (textContent) {
        result.push({ role, content: contentParts });
      }
      result.push(...functionCalls);
    } else if (contentParts.length > 0) {
      result.push({
        role,
        content: contentParts.some((part) => part.type === 'input_image') ? contentParts : textContent,
      });
    }

    result.push(...toolResults);
  }

  return result;
}

export function convertResponsesTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  enableStrict = false,
): ResponsesToolDefinition[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => {
    const parameters = sanitizeJsonSchema(tool.inputSchema) ?? { type: 'object', properties: {} };
    const strictParameters = enableStrict ? toStrictJsonSchema(parameters) : undefined;
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: strictParameters ?? parameters,
      ...(strictParameters ? { strict: true as const } : {}),
    };
  });
}

function mapResponsesRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if ((role as number) === SYSTEM_ROLE) {
    return 'system';
  }
  return 'user';
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

function mapRole(role: vscode.LanguageModelChatMessageRole, supportsDeveloperRole: boolean): 'system' | 'developer' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  if ((role as number) === SYSTEM_ROLE) {
    return supportsDeveloperRole ? 'developer' : 'system';
  }
  return 'user';
}

// ---------------------------------------------------------------------------
// Claude Messages conversion
// ---------------------------------------------------------------------------

export interface ClaudeConversionOptions {
  readonly supportsImageInput: boolean;
  readonly promptCaching?: boolean;
  readonly cacheTTL?: '5m' | '1h';
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

export function normalizeClaudeImageMediaType(value: string): string | undefined {
  const normalized = value.trim().toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : value.trim().toLowerCase();
  return CLAUDE_IMAGE_TYPES.has(normalized) ? normalized : undefined;
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

function mapClaudeRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  return (role as number) === SYSTEM_ROLE ? 'system' : 'user';
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
