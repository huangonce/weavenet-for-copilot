import * as vscode from 'vscode';
import type { ClaudeThinking, ReasoningEffort, RoutedModel } from '../relay/types';

export type ModelOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

export function getConfiguredReasoningEffort(model: RoutedModel | undefined, options: ModelOptions): ReasoningEffort | undefined {
  if (!model?.thinking) return undefined;
  const value = options.modelOptions?.reasoningEffort ?? options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
  return isReasoningEffort(value) ? value : 'high';
}

export function getConfiguredContextWindow(model: RoutedModel | undefined, options: ModelOptions): number | undefined {
  if (!model?.contextWindows?.length) return undefined;
  const value = options.modelOptions?.contextWindow ?? options.modelConfiguration?.contextWindow ?? options.configuration?.contextWindow;
  if (typeof value !== 'string' || value === 'default') return undefined;
  const window = Number(value);
  return Number.isFinite(window) && model.contextWindows.includes(window) ? window : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

export function toClaudeThinking(effort: ReasoningEffort | undefined, maxTokens: number): { thinking: ClaudeThinking } | undefined {
  if (!effort) return undefined;
  const requested = { low: 1024, medium: 4096, high: 8192, xhigh: 12000, max: 16000 }[effort];
  const budget = Math.min(requested, Math.max(0, maxTokens - 1024));
  return budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : undefined;
}

export class InvalidToolArgumentsError extends Error {
  readonly reason: 'malformed-json' | 'non-object';
  readonly argumentLength: number;

  constructor(reason: InvalidToolArgumentsError['reason'], argumentLength: number) {
    super('Relay returned invalid tool call arguments.');
    this.name = 'InvalidToolArgumentsError';
    this.reason = reason;
    this.argumentLength = argumentLength;
  }
}

export function parseToolArguments(value: string): object {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidToolArgumentsError('malformed-json', value.length);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidToolArgumentsError('non-object', value.length);
  }
  return parsed;
}

export function estimateTextTokens(value: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

export function reportThinking(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  text: string,
): void {
  const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart })
    .LanguageModelThinkingPart;
  progress.report(ThinkingPart ? new ThinkingPart(text) : new vscode.LanguageModelTextPart(text));
}
