import type { ResponsesOutputItem, ResponsesOutputItemMessage, ResponsesStreamEvent } from './types';
import { cloneReplayState, MAX_PROTOCOL_REPLAY_ITEMS, ReplayBudget } from './replayState';

/** Retains message boundaries and phase even when only added+delta events carry them. */
export class ResponsesReplayCollector {
  private readonly items = new Map<number, ResponsesOutputItem>();
  private readonly indices = new Map<string, number>();
  private readonly sizes = new Map<number, number>();
  private readonly budget = new ReplayBudget();
  private nextIndex = 0;

  consume(event: ResponsesStreamEvent): void {
    if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item) {
      const existing = event.type === 'response.output_item.done' && event.output_index === undefined && !event.item.id
        ? [...this.items].filter(([, item]) => item.type === event.item!.type) : [];
      this.put(event.item, event.output_index ?? (existing.length === 1 ? existing[0][0] : undefined));
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const index = this.index(event.output_index ?? (event.item_id ? undefined : 0), event.item_id);
      const prior = this.items.get(index);
      let item: ResponsesOutputItemMessage = prior?.type === 'message' ? prior
        : { type: 'message', role: 'assistant', id: event.item_id, content: [] };
      if (!prior) {
        this.put(item, index);
        item = this.items.get(index) as ResponsesOutputItemMessage;
      }
      const partIndex = event.content_index ?? 0;
      if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Invalid Responses content index.');
      const content = item.content ??= [];
      while (content.length <= partIndex) content.push({ type: 'output_text', text: '' });
      const delta = event.delta ?? '';
      this.budget.reserve(delta);
      this.sizes.set(index, (this.sizes.get(index) ?? 0) + Buffer.byteLength(delta, 'utf8'));
      if (event.type === 'response.refusal.delta') {
        content[partIndex] = { type: 'refusal', refusal: (content[partIndex].refusal ?? '') + delta };
      } else {
        content[partIndex] = { type: 'output_text', text: (content[partIndex].text ?? '') + delta };
      }
    } else if (event.type === 'response.reasoning_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
      const index = this.index(event.output_index ?? (event.item_id ? undefined : 0), event.item_id);
      const prior = this.items.get(index);
      if (prior && prior.type !== 'reasoning') throw new Error('Responses changed the type of an output index.');
      if (!prior) this.put({ type: 'reasoning', id: event.item_id, content: [], summary: [] }, index);
      const item = this.items.get(index);
      if (item?.type !== 'reasoning') return;
      const partIndex = event.summary_index ?? event.content_index ?? 0;
      if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Invalid Responses reasoning index.');
      const delta = event.delta ?? '';
      this.budget.reserve(delta);
      this.sizes.set(index, (this.sizes.get(index) ?? 0) + Buffer.byteLength(delta, 'utf8'));
      if (event.type === 'response.reasoning_summary_text.delta') {
        const parts = item.summary ??= [];
        while (parts.length <= partIndex) parts.push({ type: 'summary_text', text: '' });
        parts[partIndex].text += delta;
      } else {
        const parts = item.content ??= [];
        while (parts.length <= partIndex) parts.push({ type: 'reasoning_text', text: '' });
        parts[partIndex].text += delta;
      }
    } else if (event.type === 'response.function_call_arguments.done') {
      const index = this.index(event.output_index, event.item_id);
      const item = this.items.get(index);
      if (item?.type === 'function_call' && event.arguments !== undefined) this.put({ ...item, arguments: event.arguments }, index);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const index = this.index(event.output_index, event.item_id);
      const item = this.items.get(index);
      if (item?.type === 'function_call') {
        const delta = event.delta ?? '';
        this.budget.reserve(delta);
        this.sizes.set(index, (this.sizes.get(index) ?? 0) + Buffer.byteLength(delta, 'utf8'));
        item.arguments += delta;
      }
    }
  }

  finish(output?: readonly ResponsesOutputItem[]): ResponsesOutputItem[] {
    if (output?.length) {
      for (const [index, item] of output.entries()) this.put(item, index);
      for (const index of this.items.keys()) if (index >= output.length) this.items.delete(index);
    }
    return cloneReplayState([...this.items].sort(([a], [b]) => a - b).map(([, item]) => item));
  }

  private put(raw: ResponsesOutputItem, explicitIndex?: number): void {
    if (!['message', 'function_call', 'reasoning'].includes(raw.type)) return;
    const index = this.index(explicitIndex, raw.id);
    if (!this.items.has(index) && this.items.size >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Responses returned too many output items.');
    const prior = this.items.get(index);
    const item = cloneReplayState(raw);
    const sameItem = prior && (!item.id || !prior.id || item.id === prior.id);
    if (sameItem && item.type === 'message' && prior.type === 'message') {
      if (!Object.hasOwn(item, 'phase') && Object.hasOwn(prior, 'phase')) item.phase = prior.phase;
      if (!item.content) item.content = prior.content;
    }
    if (sameItem && item.type === 'reasoning' && prior.type === 'reasoning') {
      if (!item.content?.length && prior.content?.length) item.content = prior.content;
      if (!item.summary?.length && prior.summary?.length) item.summary = prior.summary;
    }
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    this.budget.adjust(bytes - (this.sizes.get(index) ?? 0));
    this.sizes.set(index, bytes);
    this.items.set(index, item);
    if (item.id) this.indices.set(item.id, index);
  }

  private index(explicit?: number, id?: string): number {
    const index = explicit ?? (id ? this.indices.get(id) : undefined) ?? this.nextIndex;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PROTOCOL_REPLAY_ITEMS) throw new Error('Invalid Responses output index.');
    this.nextIndex = Math.max(this.nextIndex, index + 1);
    return index;
  }
}
