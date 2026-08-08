import * as vscode from 'vscode';
import type { ClaudeUsage, OpenAIUsage } from '../relay/types';
import type { CanonicalChatRequestSnapshot, CanonicalInputPart } from './canonicalRequest';
import { estimateTextTokens } from './helpers';

const COPILOT_USAGE_MIME_TYPE = 'usage';
const CALIBRATION_WEIGHT = 0.3;
const MIN_CALIBRATION_FACTOR = 0.25;
const MAX_CALIBRATION_FACTOR = 8;

interface NormalizedUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

/**
 * Owns the Copilot usage seam for every upstream protocol. A request session
 * retains only the latest cumulative counters, reports exactly one `usage`
 * data part after a successful stream, and feeds the real prompt count back
 * into the model-specific token estimator.
 */
export class AdaptiveTokenUsage {
  private readonly calibrationByModel = new Map<string, number>();

  count(
    modelId: string,
    value: string | vscode.LanguageModelChatRequestMessage,
  ): number {
    return applyCalibration(baseTokenCount(value), this.calibrationByModel.get(modelId) ?? 1);
  }

  begin(modelId: string, request: CanonicalChatRequestSnapshot): ResponseUsageSession {
    return new ResponseUsageSession(
      estimateCanonicalRequestTokens(request),
      (observedFactor) => this.updateCalibration(modelId, observedFactor),
    );
  }

  private updateCalibration(modelId: string, observedFactor: number): void {
    const current = this.calibrationByModel.get(modelId) ?? 1;
    const bounded = clamp(observedFactor, MIN_CALIBRATION_FACTOR, MAX_CALIBRATION_FACTOR);
    this.calibrationByModel.set(
      modelId,
      current * (1 - CALIBRATION_WEIGHT) + bounded * CALIBRATION_WEIGHT,
    );
  }
}

export class ResponseUsageSession {
  private latest: NormalizedUsage = {};
  private finished = false;

  constructor(
    private readonly estimatedPromptTokens: number,
    private readonly onObservedFactor: (factor: number) => void,
  ) {}

  recordOpenAI(usage: OpenAIUsage): void {
    this.merge({
      promptTokens: tokenCount(usage.prompt_tokens),
      completionTokens: tokenCount(usage.completion_tokens),
      cachedTokens: tokenCount(usage.prompt_tokens_details?.cached_tokens),
      totalTokens: tokenCount(usage.total_tokens),
    });
  }

  recordClaude(usage: ClaudeUsage): void {
    const uncached = tokenCount(usage.input_tokens);
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
    const cacheRead = tokenCount(usage.cache_read_input_tokens);
    const promptParts = [uncached, cacheWrite, cacheRead].filter((value): value is number => value !== undefined);
    this.merge({
      ...(promptParts.length > 0 ? { promptTokens: promptParts.reduce((total, value) => total + value, 0) } : {}),
      completionTokens: tokenCount(usage.output_tokens),
      cachedTokens: cacheRead,
    });
  }

  /** Returns at most one part; a failed/cancelled caller simply never finishes the session. */
  finish(): vscode.LanguageModelDataPart | undefined {
    if (this.finished) return undefined;
    this.finished = true;
    const promptTokens = this.latest.promptTokens;
    const completionTokens = this.latest.completionTokens;
    if (promptTokens === undefined && completionTokens === undefined) return undefined;

    if (promptTokens !== undefined && promptTokens > 0 && this.estimatedPromptTokens > 0) {
      this.onObservedFactor(promptTokens / this.estimatedPromptTokens);
    }

    const prompt = promptTokens ?? 0;
    const completion = completionTokens ?? 0;
    const payload = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: this.latest.totalTokens ?? prompt + completion,
      prompt_tokens_details: {
        cached_tokens: this.latest.cachedTokens ?? 0,
      },
    };
    return new vscode.LanguageModelDataPart(
      new TextEncoder().encode(JSON.stringify(payload)),
      COPILOT_USAGE_MIME_TYPE,
    );
  }

  private merge(next: NormalizedUsage): void {
    if (this.finished) return;
    this.latest = {
      ...this.latest,
      ...definedEntries(next),
    };
  }
}

function baseTokenCount(value: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof value === 'string') return estimateTextTokens(value);
  let tokens = 4;
  for (const part of value.content) tokens += estimateVscodePartTokens(part);
  return Math.max(1, tokens);
}

function estimateVscodePartTokens(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) return estimateTextTokens(part.value);
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return estimateTextTokens(part.name) + estimateTextTokens(safeJson(part.input));
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return estimateTextTokens(safeJson(part.content));
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return Math.max(256, Math.ceil(part.data.byteLength / 768));
  }
  return estimateThinkingTokens(part);
}

function estimateCanonicalRequestTokens(request: CanonicalChatRequestSnapshot): number {
  let tokens = 0;
  for (const message of request.messages) {
    tokens += 4;
    for (const part of message.content) tokens += estimateCanonicalPartTokens(part);
  }
  return Math.max(1, tokens);
}

function estimateCanonicalPartTokens(part: CanonicalInputPart): number {
  switch (part.kind) {
    case 'text':
    case 'thinking':
      return estimateTextTokens(part.value);
    case 'data':
      return Math.max(256, Math.ceil(part.byteLength / 768));
    case 'toolCall':
      return estimateTextTokens(part.name) + estimateTextTokens(part.inputJson);
    case 'toolResult':
      return part.content.reduce((total, item) => total + estimateCanonicalPartTokens(item), 0);
    default:
      return assertNever(part);
  }
}

function estimateThinkingTokens(part: unknown): number {
  const ThinkingPart = (vscode as unknown as {
    LanguageModelThinkingPart?: new (...args: never[]) => { value: string | string[] };
  }).LanguageModelThinkingPart;
  if (!ThinkingPart || !(part instanceof ThinkingPart)) return 0;
  return estimateTextTokens(Array.isArray(part.value) ? part.value.join('') : part.value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function applyCalibration(base: number, factor: number): number {
  return Math.max(1, Math.ceil(base * factor));
}

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function definedEntries(value: NormalizedUsage): NormalizedUsage {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertNever(value: never): never {
  throw new Error(`Unsupported canonical request part: ${String(value)}`);
}
