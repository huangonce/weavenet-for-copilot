import * as vscode from 'vscode';
import { t } from '../l10n';
import type { CanonicalChatMessage } from './canonicalRequest';
import { canonicalToolInput } from './canonicalRequest';
import type { ApiType } from '../config/config';
import type { ProtocolReplayState } from '../relay/replayState';
import { parseToolArguments } from './helpers';
import { replayDisplayText } from '../relay/replayState';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stable(entry)]));
}

/** Match the visible history as well as identity; never resurrect deleted/edited tool calls. */
export function matchingReplayStates(message: CanonicalChatMessage, apiType: ApiType, identity?: string): readonly ProtocolReplayState[] {
  if (message.role !== 'assistant' || !identity) return [];
  const states = message.content.flatMap((part) => part.kind === 'thinking' && part.protocolReplay
    && part.protocolReplay.apiType === apiType && part.protocolReplay.identity === identity ? [part.protocolReplay] : []);
  if (!states.length) return [];
  const displayText = message.content.filter((part) => part.kind === 'text').map((part) => part.value).join('');
  const expectedText = states.map((state) => state.displayText).join('');
  const payloadText = states.map(replayDisplayText).join('');
  const actualTools = message.content.flatMap((part) => part.kind === 'toolCall'
    ? [{ id: part.callId, name: part.name, input: canonicalToolInput(part) }] : []);
  const expectedTools = states.flatMap((state) => {
    if (state.apiType === 'messages') return (state.claude ?? []).flatMap((block) => block.type === 'tool_use'
      ? [{ id: block.id, name: block.name, input: block.input }] : []);
    if (state.apiType === 'chat-completions') return (state.chat?.tool_calls ?? []).map((call) => ({
      id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments),
    }));
    return (state.responses ?? []).flatMap((item) => item.type === 'function_call' ? [{
      id: item.call_id ?? '', name: item.name, input: parseToolArguments(item.arguments),
    }] : []);
  });
  if (displayText !== expectedText || payloadText !== expectedText || JSON.stringify(stable(actualTools)) !== JSON.stringify(stable(expectedTools))) {
    throw new vscode.LanguageModelError(t('The saved protocol state no longer matches this conversation. Start a new conversation after editing or trimming its assistant/tool history.'));
  }
  return states;
}

export function hasForeignProtocolState(message: CanonicalChatMessage, apiType: ApiType, identity?: string): boolean {
  return message.content.some((part) => part.kind === 'thinking' && !!part.protocolReplay
    && (part.protocolReplay.apiType !== apiType || part.protocolReplay.identity !== identity));
}
