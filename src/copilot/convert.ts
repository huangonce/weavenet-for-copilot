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
import {
  canonicalToolInput,
  isCanonicalImagePart,
} from './canonicalRequest';
import type {
  CanonicalChatRequestSnapshot,
  CanonicalDataPart,
  CanonicalInputPart,
  CanonicalMessageRole,
  CanonicalThinkingPart,
  CanonicalToolResultContentPart,
} from './canonicalRequest';

const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const OPENAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Thinking models reject empty reasoning_text, so tool calls without recoverable thinking need a stand-in. */
const REASONING_PLACEHOLDER = '(reasoning omitted)';
/** Namespaced so the shared thinking-part metadata bag cannot collide with other providers. */
export const RESPONSES_REASONING_METADATA_KEY = 'weavenetResponsesReasoning';

/**
 * Rebuilds the original reasoning item from a replayed thinking part. The
 * encrypted payload is opaque and is only ever passed back verbatim, which is
 * what makes reasoning replay possible without server-side storage.
 */
export function encryptedReasoningItem(part: CanonicalThinkingPart): ResponsesInputItem | undefined {
  if (!part.encryptedContent || !part.id) return undefined;
  return {
    type: 'reasoning',
    id: part.id,
    encrypted_content: part.encryptedContent,
    summary: [...part.summary],
  };
}

export function convertMessages(
  request: CanonicalChatRequestSnapshot,
  supportsImageInput: boolean,
  supportsDeveloperRole = false,
): ChatMessage[] {
  const messages = request.messages;
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role, supportsDeveloperRole);
    assertRolePartCompatibility(message.role, message.content, 'OpenAI Chat Completions');
    if ((role === 'system' || role === 'developer') && message.content.some(isCanonicalImagePart)) {
      if (!supportsImageInput) throw unsupportedImageCapabilityError('OpenAI Chat Completions');
      throw unsupportedImageRoleError('OpenAI Chat Completions', role);
    }
    const contentParts: ChatContentPart[] = [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];
    const toolResults: ChatMessage[] = [];

    for (const part of message.content) {
      if (part.kind === 'text') {
        textContent += part.value;
        contentParts.push({ type: 'text', text: part.value });
      } else if (part.kind === 'toolCall') {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.inputJson,
          },
        });
      } else if (part.kind === 'toolResult') {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: stringifyToolResult(part.content),
        });
      } else if (part.kind === 'data') {
        const imagePart = requireOpenAIImage(part, 'OpenAI Chat Completions');
        if (!supportsImageInput) throw unsupportedImageCapabilityError('OpenAI Chat Completions');
        if (role === 'assistant') throw unsupportedImageRoleError('OpenAI Chat Completions', role);
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imagePart.mediaType};base64,${imagePart.base64}`,
            detail: 'auto',
            media_type: imagePart.mediaType,
          },
        });
      } else if (part.kind !== 'thinking') assertNever(part);
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
 * System messages are hoisted into the top-level `instructions` field, which
 * the spec describes as the system/developer message slot. Assistant tool
 * calls are preserved as top-level `function_call` items (not nested content
 * parts) so the following `function_call_output` items keep a matching
 * call_id; dropping them would leave the call_id dangling and can make strict
 * relays reject the history with a 400. Assistant message text uses
 * `output_text` parts, matching the output message schema that strict relays
 * validate against. A `reasoning` item requires the `id` of the response that
 * produced it: with `encryptedReasoning` the real item is carried across turns
 * on the thinking part and replayed verbatim, otherwise a stand-in is only sent
 * for relays that demand it via `replayReasoningContent`. Replayed items keep
 * their original interleaved order instead of being grouped by type.
 */
export function convertResponsesInput(
  request: CanonicalChatRequestSnapshot,
  supportsImageInput: boolean,
  replayReasoningContent = false,
  includeAssistantPhase = false,
  encryptedReasoning = false,
): { input: ResponsesInputItem[]; instructions?: string } {
  const messages = request.messages;
  const result: ResponsesInputItem[] = [];
  const instructionParts: string[] = [];

  for (const message of messages) {
    const role = mapResponsesRole(message.role);
    assertRolePartCompatibility(message.role, message.content, 'OpenAI Responses');
    if (role === 'system') {
      for (const part of message.content) {
        if (part.kind === 'text') {
          instructionParts.push(part.value);
        } else if (isCanonicalImagePart(part)) {
          if (!supportsImageInput) throw unsupportedImageCapabilityError('OpenAI Responses');
          throw unsupportedImageRoleError('OpenAI Responses', role);
        }
      }
      continue;
    }
    const toolResults: ResponsesInputItem[] = [];

    if (role === 'assistant') {
      // Items are emitted in their original interleaved order rather than
      // grouped by type, so replayed history matches the order the model
      // produced it in. A real reasoning item (carried across turns on the
      // thinking part) replays at its own position; the synthesized stand-in
      // stays directly in front of each group of tool calls, which is the
      // placement the relays requiring it expect.
      const parts = [...message.content];
      const lastToolCallIndex = parts.findLastIndex((part) => part.kind === 'toolCall');
      let segment: ResponsesInputContentPart[] = [];
      let segmentIndex = 0;
      let pendingThinking = '';
      let previousWasToolCall = false;
      const flushText = () => {
        if (segment.length === 0) return;
        result.push({
          role,
          content: segment,
          ...(includeAssistantPhase
            ? { phase: segmentIndex < lastToolCallIndex ? ('commentary' as const) : ('final_answer' as const) }
            : {}),
        });
        segment = [];
      };

      for (const [index, part] of parts.entries()) {
        if (part.kind === 'toolCall') {
          flushText();
          if (replayReasoningContent && !encryptedReasoning && !previousWasToolCall) {
            result.push({
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: pendingThinking || REASONING_PLACEHOLDER }],
              summary: [],
            });
          }
          result.push({
            type: 'function_call',
            call_id: part.callId,
            name: part.name,
            arguments: part.inputJson,
          });
          previousWasToolCall = true;
          continue;
        }
        previousWasToolCall = false;
        if (part.kind === 'text') {
          if (segment.length === 0) segmentIndex = index;
          segment.push({ type: 'output_text', text: part.value });
        } else if (part.kind === 'toolResult') {
          toolResults.push({
            type: 'function_call_output',
            call_id: part.callId,
            output: stringifyToolResult(part.content),
          });
        } else if (part.kind === 'thinking') {
          const replayed = encryptedReasoning ? encryptedReasoningItem(part) : undefined;
          if (replayed) {
            flushText();
            result.push(replayed);
          } else {
            pendingThinking += part.value;
          }
        } else if (part.kind === 'data') {
          requireCanonicalImage(part);
          if (!supportsImageInput) throw unsupportedImageCapabilityError('OpenAI Responses');
          throw unsupportedImageRoleError('OpenAI Responses', role);
        } else assertNever(part);
      }
      flushText();
    } else {
      const contentParts: ResponsesInputContentPart[] = [];
      let textContent = '';
      for (const part of message.content) {
        if (part.kind === 'text') {
          textContent += part.value;
          contentParts.push({ type: 'input_text', text: part.value });
        } else if (part.kind === 'toolResult') {
          toolResults.push({
            type: 'function_call_output',
            call_id: part.callId,
            output: stringifyToolResult(part.content),
          });
        } else if (part.kind === 'data') {
          const imagePart = requireOpenAIImage(part, 'OpenAI Responses');
          if (!supportsImageInput) throw unsupportedImageCapabilityError('OpenAI Responses');
          contentParts.push({
            type: 'input_image',
            image_url: `data:${imagePart.mediaType};base64,${imagePart.base64}`,
            detail: 'auto',
          });
        } else if (part.kind === 'toolCall') {
          throw new vscode.LanguageModelError('A tool call cannot appear in a user message and cannot be sent safely.');
        } else if (part.kind !== 'thinking') assertNever(part);
      }
      if (contentParts.length > 0) {
        result.push({
          role,
          content: contentParts.some((part) => part.type === 'input_image') ? contentParts : textContent,
        });
      }
    }

    result.push(...toolResults);
  }

  return {
    input: result,
    ...(instructionParts.length > 0 ? { instructions: instructionParts.join('\n\n') } : {}),
  };
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

function mapResponsesRole(role: CanonicalMessageRole): 'system' | 'user' | 'assistant' {
  if (role === 'assistant') {
    return 'assistant';
  }
  if (role === 'system') {
    return 'system';
  }
  if (role === 'user') return 'user';
  throw unsupportedMessageRoleError();
}

function stringifyToolResult(content: readonly CanonicalToolResultContentPart[]): string {
  if (content.some(isCanonicalImagePart)) {
    throw new vscode.LanguageModelError(
      'This Relay protocol cannot encode images inside tool results. Attach the image to a user message instead.',
    );
  }
  let result = '';
  for (const part of content) {
    if (part.kind === 'text') {
      result += part.value;
    }
  }
  if (result) return result;
  if (content.some((part) => part.kind === 'data')) {
    throw new vscode.LanguageModelError(
      'This Relay protocol cannot encode non-text data inside tool results. Return text instead.',
    );
  }
  return '';
}

function unsupportedImageRoleError(protocol: string, role: string): vscode.LanguageModelError {
  return new vscode.LanguageModelError(
    `${protocol} cannot encode image attachments in ${role} messages. Attach the image to a user message instead.`,
  );
}

function unsupportedImageCapabilityError(protocol: string): vscode.LanguageModelError {
  return new vscode.LanguageModelError(
    `${protocol} target does not support image input. Resolve the image through the vision proxy before conversion.`,
  );
}

function unsupportedMessageRoleError(): vscode.LanguageModelError {
  return new vscode.LanguageModelError('This message role is not supported and cannot be sent safely.');
}

function requireCanonicalImage(part: CanonicalDataPart): CanonicalDataPart {
  if (isCanonicalImagePart(part)) return part;
  throw new vscode.LanguageModelError(
    'This Relay protocol cannot encode non-image data attachments. Convert the data to text before sending it.',
  );
}

function requireOpenAIImage(
  part: CanonicalDataPart,
  protocol: 'OpenAI Chat Completions' | 'OpenAI Responses',
): { readonly mediaType: string; readonly base64: string } {
  requireCanonicalImage(part);
  const mediaType = normalizeImageMediaType(part.mimeType, OPENAI_IMAGE_TYPES);
  if (!mediaType) {
    throw new vscode.LanguageModelError(
      `${protocol} accepts only JPEG, PNG, GIF, or WebP image attachments. Convert the image and try again.`,
    );
  }
  return { mediaType, base64: part.base64 };
}

function assertRolePartCompatibility(
  role: CanonicalMessageRole,
  content: readonly CanonicalInputPart[],
  protocol: string,
): void {
  for (const part of content) {
    if (part.kind === 'toolCall' && role !== 'assistant') {
      throw new vscode.LanguageModelError(`${protocol} cannot encode a tool call in a ${role} message.`);
    }
    if (part.kind === 'toolResult' && role !== 'user') {
      throw new vscode.LanguageModelError(`${protocol} cannot encode a tool result in a ${role} message.`);
    }
    if (part.kind === 'thinking' && role !== 'assistant') {
      throw new vscode.LanguageModelError(`${protocol} cannot encode thinking data in a ${role} message.`);
    }
  }
}

function assertNever(value: never): never {
  throw new vscode.LanguageModelError(`Unsupported canonical message part: ${String(value)}`);
}

function mapRole(role: CanonicalMessageRole, supportsDeveloperRole: boolean): 'system' | 'developer' | 'user' | 'assistant' {
  if (role === 'assistant') {
    return 'assistant';
  }
  if (role === 'system') {
    return supportsDeveloperRole ? 'developer' : 'system';
  }
  if (role === 'user') return 'user';
  throw unsupportedMessageRoleError();
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
  request: CanonicalChatRequestSnapshot,
  options: ClaudeConversionOptions,
): { system?: string | ClaudeContentBlockText[]; messages: ClaudeMessage[] } {
  const messages = request.messages;
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
    assertRolePartCompatibility(message.role, message.content, 'Claude Messages');
    const blocks: ClaudeContentBlock[] = [];
    let textContent = '';
    let interruptsToolChain = false;
    if (role === 'assistant' || role === 'system') discardPendingToolUses();
    for (const part of message.content) {
      if (part.kind === 'text') {
        textContent += part.value;
        // Anthropic rejects empty text blocks.
        if (part.value) blocks.push({ type: 'text', text: part.value });
        interruptsToolChain = role === 'user';
      } else if (part.kind === 'toolCall') {
        blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: canonicalToolInput(part) });
        if (role === 'assistant') pendingToolUseIds.add(part.callId);
      } else if (part.kind === 'toolResult') {
        if (part.content.some(isCanonicalImagePart)) {
          throw new vscode.LanguageModelError(
            'This Relay protocol cannot encode images inside tool results. Attach the image to a user message instead.',
          );
        }
        if (role === 'user' && pendingToolUseIds.has(part.callId)) {
          blocks.push({ type: 'tool_result', tool_use_id: part.callId, content: stringifyToolResult(part.content) });
          pendingToolUseIds.delete(part.callId);
        }
      } else if (part.kind === 'data') {
        const imagePart = requireCanonicalImage(part);
        if (!options.supportsImageInput) throw unsupportedImageCapabilityError('Claude Messages');
        if (role !== 'user') throw unsupportedImageRoleError('Claude Messages', role);
        const mediaType = normalizeClaudeImageMediaType(imagePart.mimeType);
        if (!mediaType) {
          throw new vscode.LanguageModelError(
            'Claude Messages accepts only JPEG, PNG, GIF, or WebP image attachments. Convert the image and try again.',
          );
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imagePart.base64 },
        });
        interruptsToolChain = role === 'user';
      } else if (part.kind !== 'thinking') assertNever(part);
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
  return normalizeImageMediaType(value, CLAUDE_IMAGE_TYPES);
}

function normalizeImageMediaType(value: string, allowed: ReadonlySet<string>): string | undefined {
  const normalized = value.trim().toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
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

function mapClaudeRole(role: CanonicalMessageRole): 'system' | 'user' | 'assistant' {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'user') return 'user';
  throw unsupportedMessageRoleError();
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
