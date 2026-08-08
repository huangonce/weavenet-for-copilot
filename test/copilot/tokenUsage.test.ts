import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { AdaptiveTokenUsage } from '../../src/copilot/tokenUsage';

function request(text = 'hello') {
  return snapshotChatRequest([
    vscode.LanguageModelChatMessage.User(text),
  ]);
}

function decode(part: vscode.LanguageModelDataPart): unknown {
  return JSON.parse(new TextDecoder().decode(part.data));
}

describe('AdaptiveTokenUsage', () => {
  it('merges cumulative OpenAI counters and emits exactly one Copilot usage part', () => {
    const usage = new AdaptiveTokenUsage();
    const session = usage.begin('model-a', request());
    session.recordOpenAI({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    session.recordOpenAI({ completion_tokens: 40, total_tokens: 140 });

    const part = session.finish();

    expect(part).toBeInstanceOf(vscode.LanguageModelDataPart);
    expect(part?.mimeType).toBe('usage');
    expect(decode(part!)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    expect(session.finish()).toBeUndefined();
  });

  it('combines Claude cache counters into the effective prompt size', () => {
    const usage = new AdaptiveTokenUsage();
    const session = usage.begin('claude-a', request());
    session.recordClaude({
      input_tokens: 60,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 30,
    });
    session.recordClaude({ output_tokens: 25 });

    expect(decode(session.finish()!)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 30 },
    });
  });

  it('calibrates estimates per model with a bounded moving average', () => {
    const usage = new AdaptiveTokenUsage();
    const text = 'a'.repeat(400);
    expect(usage.count('model-a', text)).toBe(100);
    expect(usage.count('model-b', text)).toBe(100);
    const session = usage.begin('model-a', request(text));
    session.recordOpenAI({ prompt_tokens: 10_000, completion_tokens: 1 });

    session.finish();

    // The observed correction is capped at 8x, then blended 30% into 1x.
    expect(usage.count('model-a', text)).toBe(310);
    expect(usage.count('model-b', text)).toBe(100);
  });

  it('ignores invalid or late counters and does not fabricate usage', () => {
    const usage = new AdaptiveTokenUsage();
    const session = usage.begin('model-a', request());
    session.recordOpenAI({ prompt_tokens: Number.NaN, completion_tokens: -1 });
    expect(session.finish()).toBeUndefined();
    session.recordOpenAI({ prompt_tokens: 10, completion_tokens: 2 });
    expect(session.finish()).toBeUndefined();
  });

  it('falls back safely when a tool input cannot be serialized', () => {
    const usage = new AdaptiveTokenUsage();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const message = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelToolCallPart('call-1', 'tool', circular)],
    } as unknown as vscode.LanguageModelChatRequestMessage;

    expect(() => usage.count('model-a', message)).not.toThrow();
    expect(usage.count('model-a', message)).toBeGreaterThan(4);
  });
});
