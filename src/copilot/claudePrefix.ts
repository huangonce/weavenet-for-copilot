import { createHash, type Hash } from 'node:crypto';
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

function appendMessage(hash: Hash, message: ClaudeMessage, index: number): void {
  if (index) hash.update(',');
  hash.update(JSON.stringify({ role: message.role, content: typeof message.content === 'string'
    ? message.content : message.content.map(cleanBlock) }));
}

function startPrefixHash(request: Pick<ClaudeRequest, 'system' | 'tools'>): Hash {
  const system = Array.isArray(request.system) ? request.system.map(cleanBlock) : request.system;
  const tools = request.tools?.map(tool => { const plain = { ...tool }; delete plain.cache_control; return plain; });
  // Retain the exact existing JSON bytes, including omitted undefined fields.
  // Remove only the empty messages array's closing bracket and object brace.
  return createHash('sha256').update(JSON.stringify({ system, tools, messages: [] }).slice(0, -2));
}

export function claudePrefix(request: Pick<ClaudeRequest, 'system' | 'tools' | 'messages'>): NonNullable<ProtocolReplayState['claudePrefix']> {
  const hash = startPrefixHash(request);
  request.messages.forEach((message, index) => appendMessage(hash, message, index));
  return { hash: hash.update(']}').digest('hex'), messageCount: request.messages.length };
}

/** Validate every retained signed turn against the exact prefix actually sent to the API. */
export function validateClaudePrefixes(snapshot: CanonicalChatRequestSnapshot, request: ClaudeRequest, identity: string): void {
  const signedStates = snapshot.messages.flatMap(message => message.content.flatMap(part => {
    const state = part.kind === 'thinking' ? part.protocolReplay : undefined;
    return state?.apiType === 'messages' && state.identity === identity
      && state.claude?.some(block => block.type === 'thinking' || block.type === 'redacted_thinking') ? [state] : [];
  }));
  if (!signedStates.length) return;
  const counts = new Set(signedStates.flatMap(state => state.claudePrefix ? [state.claudePrefix.messageCount] : []));
  const hashes = new Map<number, string>();
  const hash = startPrefixHash(request);
  // A single pass computes all retained prefixes. Copies contain only hash
  // state, so neither previous messages nor their serialized bodies are kept.
  for (let index = 0; index < request.messages.length && hashes.size < counts.size; index++) {
    if (counts.has(index)) hashes.set(index, hash.copy().update(']}').digest('hex'));
    if (hashes.size === counts.size) break;
    appendMessage(hash, request.messages[index], index);
  }
  for (const state of signedStates) {
    const prefix = state.claudePrefix;
    if (!prefix) throw new vscode.LanguageModelError(t('This signed thinking history has no prefix fingerprint. Start a new conversation after upgrading.'));
    const ownTurn = request.messages[prefix.messageCount];
    const actualBlocks = ownTurn?.role === 'assistant' && Array.isArray(ownTurn.content) ? ownTurn.content : [];
    const expectedBlocks = state.claude!.filter(block => block.type !== 'text' || !!block.text);
    if (hashes.get(prefix.messageCount) !== prefix.hash || request.messages.length <= prefix.messageCount
      || JSON.stringify(actualBlocks.slice(0, expectedBlocks.length).map(cleanBlock)) !== JSON.stringify(expectedBlocks.map(cleanBlock))) {
      throw new vscode.LanguageModelError(t('The system prompt, tools or earlier messages changed before signed thinking. Start a new conversation; invalid signatures were not sent.'));
    }
  }
}
