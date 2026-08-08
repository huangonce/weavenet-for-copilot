import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ResponsePartEmitter } from '../../src/copilot/responsePartEmitter';

afterEach(() => {
  vi.useRealTimers();
});

describe('ResponsePartEmitter', () => {
  it('coalesces thousands of token deltas into bounded progress reports', () => {
    const reported: vscode.LanguageModelResponsePart[] = [];
    const emitter = createEmitter(reported, 100, 8_192);

    for (let index = 0; index < 10_000; index++) emitter.text('x');
    emitter.flush();

    expect(reported).toHaveLength(2);
    expect(reported.map((part) => (part as vscode.LanguageModelTextPart).value.length)).toEqual([8_192, 1_808]);
  });

  it('flushes adjacent deltas once per interval', () => {
    vi.useFakeTimers();
    const reported: vscode.LanguageModelResponsePart[] = [];
    const emitter = createEmitter(reported);

    emitter.text('one');
    emitter.text(' two');
    expect(reported).toEqual([]);

    vi.advanceTimersByTime(100);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect((reported[0] as vscode.LanguageModelTextPart).value).toBe('one two');
  });

  it('preserves text, thinking, metadata, and tool-call order', () => {
    const reported: vscode.LanguageModelResponsePart[] = [];
    const emitter = createEmitter(reported);

    emitter.text('answer');
    emitter.thinking('thought');
    emitter.thinking('', 'reasoning-1', { encrypted: true });
    emitter.report(new vscode.LanguageModelToolCallPart('call-1', 'search', { q: 'docs' }));

    expect(reported).toHaveLength(4);
    expect(reported[0]).toMatchObject({ value: 'answer' });
    expect(reported[1]).toMatchObject({ value: 'thought' });
    expect(reported[2]).toMatchObject({ value: '', id: 'reasoning-1', metadata: { encrypted: true } });
    expect(reported[3]).toMatchObject({ callId: 'call-1', name: 'search' });
  });

  it('contains asynchronous progress failures and surfaces them through the request', () => {
    vi.useFakeTimers();
    const failure = new Error('progress channel closed');
    const progress = { report: vi.fn(() => { throw failure; }) } as vscode.Progress<vscode.LanguageModelResponsePart>;
    const emitter = new ResponsePartEmitter(progress);

    emitter.text('pending');
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(() => emitter.flush()).toThrow(failure);
  });

  it('discards pending output and timers after cancellation', () => {
    vi.useFakeTimers();
    const reported: vscode.LanguageModelResponsePart[] = [];
    const emitter = createEmitter(reported);

    emitter.text('cancelled');
    emitter.discard();
    vi.runAllTimers();

    expect(reported).toEqual([]);
  });
});

function createEmitter(
  reported: vscode.LanguageModelResponsePart[],
  flushIntervalMs = 100,
  maxBufferedCharacters = 8_192,
): ResponsePartEmitter {
  return new ResponsePartEmitter(
    { report: (part) => reported.push(part) },
    flushIntervalMs,
    maxBufferedCharacters,
  );
}
