import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfig } from '../../src/config/config';
import { createRequestDiagnostics } from '../../src/copilot/requestDiagnostics';
import type { RelayProtocol } from '../../src/relay/types';
import { processResponsesFullResponse, processResponsesSseLine } from '../../src/relay/openaiResponses';

beforeEach(() => vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined } as never));
afterEach(() => vi.restoreAllMocks());

function diagnostics(protocol: RelayProtocol) {
  const lines: string[] = [];
  const current = createRequestDiagnostics((_config, message) => lines.push(message), getConfig(), protocol, 'model', 1, 0);
  return { current, lines, summaries: () => lines.filter(line => /request (completed|failed|cancelled):/.test(line)) };
}

describe('request usage summaries', () => {
  it('merges cumulative Claude usage without adding events or losing omitted fields', () => {
    const { current, summaries } = diagnostics('Claude');
    current.onClaudeUsage({ input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 }, output_tokens: 1 }, 'msg_test');
    current.onClaudeUsage({ output_tokens: 5 });
    current.onClaudeUsage({ output_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 5 } });
    current.complete();

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toContain('usage={inputTotal:120,output:7,total:127,cacheRead:60,cacheWrite:20,inputUncached:40,cacheWrite5m:15,cacheWrite1h:5}');
    expect(summaries()[0]).toContain('usageResponseId=msg_test');
  });

  it('does not treat omitted cache counts as zero when calculating Claude totals', () => {
    const { current, summaries } = diagnostics('Claude');
    current.onClaudeUsage({ input_tokens: 40, cache_read_input_tokens: 0, output_tokens: 7 });
    current.complete();
    expect(summaries()[0]).toContain('usage={inputTotal:n/a,output:7,total:n/a,cacheRead:0,cacheWrite:n/a');
    expect(summaries()[0]).toContain('cacheWrite5m:n/a,cacheWrite1h:n/a');
  });

  it('keeps explicitly reported zero counts', () => {
    const { current, summaries } = diagnostics('Claude');
    current.onClaudeUsage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
    current.complete();
    expect(summaries()[0]).toContain('usage={inputTotal:0,output:0,total:0,cacheRead:0,cacheWrite:0');
  });

  it('preserves OpenAI cache reads and writes when later usage omits them', () => {
    const { current, summaries } = diagnostics('OpenAI');
    current.onOpenAIUsage({ prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 } });
    current.onOpenAIUsage({ completion_tokens: 7, total_tokens: 127, completion_tokens_details: { reasoning_tokens: 3 } });
    current.complete();
    expect(summaries()[0]).toContain('usage={inputTotal:120,output:7,total:127,cacheRead:60,cacheWrite:20,reasoning:3');
  });

  it.each(['complete', 'failed', 'cancelled'] as const)('writes the first %s settlement exactly once', outcome => {
    const { current, summaries } = diagnostics('Responses');
    if (outcome === 'failed') current.failed(new Error('private body'));
    else current[outcome]();
    current.complete();
    current.failed(new Error('private body'));
    current.cancelled();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toContain('usage={inputTotal:n/a,output:n/a,total:n/a,cacheRead:n/a,cacheWrite:n/a');
    expect(summaries()[0]).not.toContain('private body');
  });

  it('ignores invalid usage values and unrecognized fields instead of logging their content', () => {
    const { current, lines, summaries } = diagnostics('OpenAI');
    current.onOpenAIUsage({ prompt_tokens: 10, completion_tokens: 2 });
    current.onOpenAIUsage({ prompt_tokens: NaN, completion_tokens: -1,
      prompt_tokens_details: { cached_tokens: 'private body', cache_write_tokens: Infinity },
      unknown: 'private body' } as never);
    current.complete();
    expect(summaries()[0]).toContain('usage={inputTotal:10,output:2,total:12,cacheRead:n/a,cacheWrite:n/a');
    expect(lines.join('\n')).not.toContain('private body');
  });
});

it.each(['stream', 'json'] as const)('retains cache writes from Responses %s usage', async mode => {
  const { current, summaries } = diagnostics('Responses');
  const usage = { input_tokens: 30, output_tokens: 4, input_tokens_details: { cache_write_tokens: 12 } };
  const callbacks = { onContent: () => undefined, onReasoning: () => undefined, onToolCall: () => undefined,
    onOpenAIUsage: current.onOpenAIUsage };
  if (mode === 'stream') {
    processResponsesSseLine(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}`,
      new Map(), callbacks, { parts: 0, started: false });
  } else {
    await processResponsesFullResponse(new Response(JSON.stringify({ status: 'completed', usage,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private answer' }] }],
    })), callbacks);
  }
  current.complete();
  expect(summaries()[0]).toContain('usage={inputTotal:30,output:4,total:34,cacheRead:n/a,cacheWrite:12');
  expect(summaries()[0]).not.toContain('private answer');
});
