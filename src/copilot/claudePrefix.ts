import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from '../l10n';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRequest } from '../relay/types';
import type { ProtocolReplayState } from '../relay/replayState';
import type { CanonicalChatRequestSnapshot } from './canonicalRequest';

/** Cache breakpoints may move; business values inside tool input must remain intact. */
function cleanBlock(block: ClaudeContentBlock): unknown {
  const plain: Record<string, unknown> = { ...block };
  delete plain.cache_control;
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return { ...plain, content: block.content.map(cleanBlock) };
  }
  return plain;
}

function cleanMessages(messages: readonly ClaudeMessage[]): unknown {
  return messages.map(message => ({ role: message.role, content: typeof message.content === 'string'
    ? message.content : message.content.map(cleanBlock) }));
}

export function claudePrefix(request: Pick<ClaudeRequest, 'system' | 'tools' | 'messages'>): NonNullable<ProtocolReplayState['claudePrefix']> {
  const system = Array.isArray(request.system) ? request.system.map(cleanBlock) : request.system;
  const tools = request.tools?.map(tool => { const plain = { ...tool }; delete plain.cache_control; return plain; });
  const hash = createHash('sha256').update(JSON.stringify({ system, tools, messages: cleanMessages(request.messages) })).digest('hex');
  return { hash, messageCount: request.messages.length };
}

/** Validate every retained signed turn against the exact prefix actually sent to the API. */
export function validateClaudePrefixes(snapshot: CanonicalChatRequestSnapshot, request: ClaudeRequest, identity: string): void {
  for (const message of snapshot.messages) for (const part of message.content) {
    const state = part.kind === 'thinking' ? part.protocolReplay : undefined;
    if (!state || state.apiType !== 'messages' || state.identity !== identity
      || !state.claude?.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')) continue;
    const prefix = state.claudePrefix;
    if (!prefix) throw new vscode.LanguageModelError(t('This signed thinking history has no prefix fingerprint. Start a new conversation after upgrading.'));
    const actual = claudePrefix({ ...request, messages: request.messages.slice(0, prefix.messageCount) });
    const ownTurn = request.messages[prefix.messageCount];
    const actualBlocks = ownTurn?.role === 'assistant' && Array.isArray(ownTurn.content) ? ownTurn.content : [];
    const expectedBlocks = state.claude.filter(block => block.type !== 'text' || !!block.text);
    if (actual.hash !== prefix.hash || request.messages.length <= prefix.messageCount
      || JSON.stringify(actualBlocks.slice(0, expectedBlocks.length).map(cleanBlock)) !== JSON.stringify(expectedBlocks.map(cleanBlock))) {
      throw new vscode.LanguageModelError(t('The system prompt, tools or earlier messages changed before signed thinking. Start a new conversation; invalid signatures were not sent.'));
    }
  }
}
