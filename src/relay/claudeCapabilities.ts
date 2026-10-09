import type { ClaudeEffort, ClaudeRequestCapabilities } from './types';

const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === 'string' && CLAUDE_EFFORTS.includes(value as ClaudeEffort);
}

export function normalizeClaudeRequestCapabilities(value: unknown): ClaudeRequestCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const thinkingMode = record.thinkingMode === 'manual' || record.thinkingMode === 'adaptive' ? record.thinkingMode : undefined;
  const reasoningEfforts = Array.isArray(record.reasoningEfforts) ? [...new Set(record.reasoningEfforts.filter(isClaudeEffort))] : undefined;
  const defaultReasoningEffort = isClaudeEffort(record.defaultReasoningEffort)
    && (!reasoningEfforts?.length || reasoningEfforts.includes(record.defaultReasoningEffort)) ? record.defaultReasoningEffort : undefined;
  const sampling = typeof record.sampling === 'boolean' ? record.sampling : undefined;
  const forcedToolChoice = typeof record.forcedToolChoice === 'boolean' ? record.forcedToolChoice : undefined;
  return thinkingMode || reasoningEfforts?.length || defaultReasoningEffort || sampling !== undefined || forcedToolChoice !== undefined
    ? { thinkingMode, reasoningEfforts, defaultReasoningEffort, sampling, forcedToolChoice } : undefined;
}
