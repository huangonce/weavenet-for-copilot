import * as vscode from 'vscode';
import {
  createCanonicalSnapshot,
  isCanonicalImagePart,
} from './canonicalRequest';
import type {
  CanonicalChatMessage,
  CanonicalChatRequestSnapshot,
  CanonicalDataPart,
  CanonicalInputPart,
  CanonicalToolResultContentPart,
} from './canonicalRequest';

const IMAGE_ONLY_TOOL_RESULT_TEXT = '[Image output attached in the following user message.]';

interface DeferredUserMessage {
  readonly content: CanonicalInputPart[];
  readonly name?: string;
}

/**
 * Relay tool-result fields are text-only. Preserve each tool result as text and
 * replay its images as an ordinary user attachment after the complete parallel
 * tool-call batch has been answered. This keeps every protocol's tool chain
 * valid without serializing image bytes into tool output strings.
 */
export function promoteNativeToolResultImages(
  snapshot: CanonicalChatRequestSnapshot,
): CanonicalChatRequestSnapshot {
  return normalizeToolResultBatches(snapshot);
}

export function normalizeToolResultBatches(
  snapshot: CanonicalChatRequestSnapshot,
): CanonicalChatRequestSnapshot {
  if (!hasToolPart(snapshot)) return snapshot;

  const messages: CanonicalChatMessage[] = [];
  const pendingToolCalls = new Set<string>();
  let pendingAssistantMessageIndex: number | undefined;
  const deferredUserMessages: DeferredUserMessage[] = [];

  const flushDeferredUserMessages = (): void => {
    for (const deferred of deferredUserMessages) {
      messages.push(createMessage('user', deferred.content, deferred.name));
    }
    deferredUserMessages.length = 0;
  };

  const discardUnansweredToolCalls = (): void => {
    if (pendingAssistantMessageIndex === undefined || pendingToolCalls.size === 0) return;
    const assistantMessage = messages[pendingAssistantMessageIndex];
    const content = assistantMessage.content.filter((part) =>
      part.kind !== 'toolCall' || !pendingToolCalls.has(part.callId));
    if (content.length === 0) messages.splice(pendingAssistantMessageIndex, 1);
    else messages[pendingAssistantMessageIndex] = createMessage(
      assistantMessage.role,
      content,
      assistantMessage.name,
    );
  };

  const endPendingBatch = (): void => {
    discardUnansweredToolCalls();
    flushDeferredUserMessages();
    pendingToolCalls.clear();
    pendingAssistantMessageIndex = undefined;
  };

  for (const message of snapshot.messages) {
    const startsNewAssistantTurn = message.role === 'assistant';
    if (startsNewAssistantTurn) {
      // A later assistant turn is a hard history boundary. If malformed or
      // partial history omitted a tool result, remove that unanswered call and
      // replay deferred user content before starting the new turn.
      endPendingBatch();
    }

    // OpenAI converters emit ordinary user content before tool outputs from
    // the same canonical message, while Claude requires tool_result blocks to
    // lead the user turn that answers tool_use. Delay all non-result user parts
    // in a pending batch so every matching output reaches the relay first.
    // Deferred text and images retain their source order.
    const inPendingUserBatch = message.role === 'user' && pendingToolCalls.size > 0;
    const deferredContent: CanonicalInputPart[] = [];
    const content: CanonicalInputPart[] = [];
    for (const part of message.content) {
      if (part.kind === 'toolCall') {
        assertUniquePendingToolCall(part.callId, pendingToolCalls);
        pendingToolCalls.add(part.callId);
        content.push(part);
        continue;
      }
      if (part.kind !== 'toolResult') {
        if (inPendingUserBatch) deferredContent.push(part);
        else content.push(part);
        continue;
      }

      if (message.role !== 'user' || !pendingToolCalls.has(part.callId)) {
        throw new vscode.LanguageModelError(
          'A tool result must match one earlier, unique, unconsumed assistant tool call.',
        );
      }

      const result = stripToolResultImages(part);
      content.push(result.part);
      deferredContent.push(...result.images);
      pendingToolCalls.delete(part.callId);
    }

    if (deferredContent.length > 0) {
      deferredUserMessages.push({ content: deferredContent, name: message.name });
    }

    messages.push(contentMatches(message.content, content)
      ? message
      : createMessage(message.role, content, message.name));
    if (startsNewAssistantTurn && pendingToolCalls.size > 0) {
      pendingAssistantMessageIndex = messages.length - 1;
    }

    if (pendingToolCalls.size === 0) {
      flushDeferredUserMessages();
      pendingAssistantMessageIndex = undefined;
    }
  }

  // Fail-safe for truncated histories: remove unanswered calls, but never
  // silently discard user content or images already present in the history.
  endPendingBatch();
  return createCanonicalSnapshot(messages);
}

function hasToolPart(snapshot: CanonicalChatRequestSnapshot): boolean {
  return snapshot.messages.some((message) =>
    message.content.some((part) => part.kind === 'toolCall' || part.kind === 'toolResult'));
}

function stripToolResultImages(
  part: Extract<CanonicalInputPart, { kind: 'toolResult' }>,
): {
  readonly part: Extract<CanonicalInputPart, { kind: 'toolResult' }>;
  readonly images: readonly CanonicalDataPart[];
} {
  const images: CanonicalDataPart[] = [];
  const content: CanonicalToolResultContentPart[] = [];
  for (const nested of part.content) {
    if (isCanonicalImagePart(nested)) images.push(nested);
    else content.push(nested);
  }
  if (images.length === 0) return { part, images };
  if (!content.some((nested) => nested.kind === 'text' && nested.value.trim())) {
    content.push(Object.freeze({ kind: 'text' as const, value: IMAGE_ONLY_TOOL_RESULT_TEXT }));
  }
  return {
    part: Object.freeze({
      kind: 'toolResult' as const,
      callId: part.callId,
      content: Object.freeze(content),
    }),
    images: Object.freeze(images),
  };
}

function assertUniquePendingToolCall(callId: string, pendingToolCalls: ReadonlySet<string>): void {
  if (pendingToolCalls.has(callId)) {
    throw new vscode.LanguageModelError(
      'Tool call IDs in one pending batch must be unique to promote image tool results safely.',
    );
  }
}

function contentMatches(
  original: readonly CanonicalInputPart[],
  replacement: readonly CanonicalInputPart[],
): boolean {
  return original.length === replacement.length
    && original.every((part, index) => part === replacement[index]);
}

function createMessage(
  role: CanonicalChatMessage['role'],
  content: readonly CanonicalInputPart[],
  name?: string,
): CanonicalChatMessage {
  return Object.freeze({
    role,
    content: Object.freeze([...content]),
    ...(name === undefined ? {} : { name }),
  });
}