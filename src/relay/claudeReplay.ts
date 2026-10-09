import type { ClaudeContentBlock, ClaudeStreamEvent } from './types';
import { cloneReplayState, MAX_PROTOCOL_REPLAY_ITEMS, ReplayBudget } from './replayState';

/** Rebuild output blocks at their original indices, independently of display deltas. */
export class ClaudeReplayCollector {
  private readonly blocks = new Map<number, NonNullable<ClaudeStreamEvent['content_block']>>();
  private readonly stopped = new Set<number>();
  private readonly toolJson = new Map<number, string>();
  private readonly budget = new ReplayBudget();

  consume(event: ClaudeStreamEvent): void {
    const index = event.index ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new Error('Claude returned an invalid content block index.');
    if (event.type === 'content_block_start' && event.content_block) {
      if (this.blocks.has(index)) throw new Error('Claude repeated a content block index.');
      if (this.blocks.size >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Claude returned too many content blocks.');
      const block = cloneReplayState(event.content_block);
      if (block.type === 'tool_use' && block.input === undefined) block.input = {};
      if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type ?? '')) {
        throw new Error('Claude returned an unsupported content block for replay.');
      }
      this.budget.reserveJson(block);
      this.blocks.set(index, block);
      return;
    }
    if (event.type === 'content_block_delta' && event.delta) {
      if (this.stopped.has(index)) throw new Error('Claude sent content after a block ended.');
      const delta = event.delta;
      let block = this.blocks.get(index);
      if (!block && (delta.type === 'text_delta' || delta.type === 'thinking_delta' || delta.type === 'signature_delta')) {
        if (this.blocks.size >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Claude returned too many content blocks.');
        block = delta.type === 'text_delta' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' };
        this.blocks.set(index, block);
      }
      if (!block) return;
      if (delta.type === 'text_delta' && delta.text !== undefined) {
        this.budget.reserve(delta.text);
        block.text = (block.text ?? '') + delta.text;
      } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
        this.budget.reserve(delta.thinking);
        block.thinking = (block.thinking ?? '') + delta.thinking;
      } else if (delta.type === 'signature_delta' && delta.signature !== undefined) {
        this.budget.reserve(delta.signature);
        block.signature = (block.signature ?? '') + delta.signature;
      } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
        this.budget.reserve(delta.partial_json);
        this.toolJson.set(index, (this.toolJson.get(index) ?? '') + delta.partial_json);
      }
    }
    if (event.type === 'content_block_stop') { this.finalizeTool(index); this.stopped.add(index); }
  }

  finish(): ClaudeContentBlock[] {
    const result: ClaudeContentBlock[] = [];
    for (const [index, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      this.finalizeTool(index);
      if (block.type === 'thinking') {
        if (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature) {
          throw new Error('Claude thinking ended without its signature; the response cannot be replayed safely.');
        }
        result.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data !== 'string' || !block.data) throw new Error('Claude returned invalid redacted thinking.');
        result.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new Error('Claude returned invalid text content.');
        result.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        if (!block.id || !block.name || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
          throw new Error('Claude returned an invalid tool block.');
        }
        result.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return cloneReplayState(result);
  }

  private finalizeTool(index: number): void {
    const text = this.toolJson.get(index);
    if (text === undefined) return;
    const block = this.blocks.get(index);
    if (block?.type === 'tool_use') block.input = JSON.parse(text || '{}');
    this.toolJson.delete(index);
  }
}
