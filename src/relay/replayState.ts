import type { ApiType } from '../config/config';
import type { ChatMessage, ClaudeContentBlock, ResponsesOutputItem } from './types';

export const PROTOCOL_REPLAY_METADATA_KEY = 'weavenetProtocolReplay';
export const MAX_PROTOCOL_REPLAY_BYTES = 4 * 1024 * 1024;
export const MAX_PROTOCOL_REPLAY_ITEMS = 512;

/** Opaque protocol data travels only in host history, never settings, logs or a global cache. */
export interface ProtocolReplayState {
  readonly version: 1;
  readonly identity: string;
  readonly apiType: ApiType;
  readonly displayText: string;
  readonly claudePrefix?: { readonly hash: string; readonly messageCount: number };
  readonly claude?: readonly ClaudeContentBlock[];
  readonly chat?: ChatMessage;
  readonly responses?: readonly ResponsesOutputItem[];
}

export class ReplayBudget {
  private bytes = 0;
  reserve(text: string): void {
    this.adjust(Buffer.byteLength(text, 'utf8'));
  }
  adjust(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > MAX_PROTOCOL_REPLAY_BYTES) throw new Error('Protocol replay state exceeds the bounded response limit.');
  }
  reserveJson(value: unknown): void {
    this.reserve(JSON.stringify(value));
  }
}

export function replayDisplayText(state: ProtocolReplayState): string {
  if (state.apiType === 'chat-completions') return typeof state.chat?.content === 'string' ? state.chat.content : '';
  if (state.apiType === 'messages') return (state.claude ?? []).flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
  return (state.responses ?? []).flatMap((item) => item.type === 'message'
    ? (item.content ?? []).map((part) => part.type === 'refusal' ? part.refusal ?? '' : part.text ?? '') : []).join('');
}

export function cloneReplayState<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROTOCOL_REPLAY_BYTES) {
    throw new Error('Protocol replay state exceeds the bounded response limit.');
  }
  return JSON.parse(serialized) as T;
}
