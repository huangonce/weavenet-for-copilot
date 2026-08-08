import * as vscode from 'vscode';
import { createThinkingPart } from './helpers';

const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BUFFERED_CHARACTERS = 8 * 1024;

type BufferedPartKind = 'text' | 'thinking';

interface BufferedPart {
  readonly kind: BufferedPartKind;
  value: string;
}

/**
 * Coalesces token-sized stream deltas before they cross the extension-host RPC
 * boundary. Some OpenAI-compatible relays emit thousands of SSE events for a
 * single answer; reporting each event individually can retain enough pending
 * RPC work to exhaust the shared Extension Host heap.
 *
 * Ordering is preserved across text, thinking, metadata, and tool-call parts.
 * Buffered output is also size-bounded, so a stalled timer cannot accumulate
 * an unbounded string.
 */
export class ResponsePartEmitter {
  private readonly pending: BufferedPart[] = [];
  private pendingCharacters = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerFailure: unknown;

  constructor(
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    private readonly maxBufferedCharacters = DEFAULT_MAX_BUFFERED_CHARACTERS,
  ) {}

  text(value: string): void {
    this.enqueue('text', value);
  }

  thinking(value: string, id?: string, metadata?: Record<string, unknown>): void {
    if (id !== undefined || metadata !== undefined) {
      const part = createThinkingPart(value, id, metadata);
      if (part) this.report(part);
      return;
    }
    this.enqueue('thinking', value);
  }

  report(part: vscode.LanguageModelResponsePart): void {
    this.flush();
    this.progress.report(part);
  }

  flush(): void {
    this.clearTimer();
    this.throwTimerFailure();
    this.flushPending();
  }

  discard(): void {
    this.clearTimer();
    this.pending.length = 0;
    this.pendingCharacters = 0;
    this.timerFailure = undefined;
  }

  private enqueue(kind: BufferedPartKind, value: string): void {
    this.throwTimerFailure();
    if (!value) return;
    const last = this.pending.at(-1);
    if (last?.kind === kind) last.value += value;
    else this.pending.push({ kind, value });
    this.pendingCharacters += value.length;
    if (this.pendingCharacters >= this.maxBufferedCharacters) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flushFromTimer(), this.flushIntervalMs);
  }

  private flushFromTimer(): void {
    this.timer = undefined;
    try {
      this.flushPending();
    } catch (error) {
      // Throwing from a timer would become an uncaught Extension Host error.
      // Remember it and surface it through the active request on the next
      // callback (or its final flush) instead.
      this.timerFailure ??= error;
      this.pending.length = 0;
      this.pendingCharacters = 0;
    }
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const parts = this.pending.splice(0);
    this.pendingCharacters = 0;
    for (const part of parts) {
      if (part.kind === 'text') {
        this.progress.report(new vscode.LanguageModelTextPart(part.value));
      } else {
        const thinking = createThinkingPart(part.value);
        if (thinking) this.progress.report(thinking);
      }
    }
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private throwTimerFailure(): void {
    if (this.timerFailure === undefined) return;
    const failure = this.timerFailure;
    this.timerFailure = undefined;
    throw failure;
  }
}
