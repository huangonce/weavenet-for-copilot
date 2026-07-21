import type { OpenAIRequestCapabilities, ReasoningEffort } from './types';

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];
const TOKEN_LIMIT_FIELDS = new Set(['max_tokens', 'max_completion_tokens', 'omit']);

/** Normalizes only documented request capabilities; unknown values are ignored. */
export function normalizeOpenAIRequestCapabilities(value: unknown): OpenAIRequestCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tokenLimitField = typeof record.tokenLimitField === 'string' && TOKEN_LIMIT_FIELDS.has(record.tokenLimitField)
    ? record.tokenLimitField as OpenAIRequestCapabilities['tokenLimitField']
    : undefined;
  const reasoningEfforts = Array.isArray(record.reasoningEfforts)
    ? [...new Set(record.reasoningEfforts.filter(isReasoningEffort))]
    : undefined;
  const defaultReasoningEffort = isReasoningEffort(record.defaultReasoningEffort)
    && (!reasoningEfforts?.length || reasoningEfforts.includes(record.defaultReasoningEffort))
    ? record.defaultReasoningEffort
    : undefined;
  const result: OpenAIRequestCapabilities = {
    tokenLimitField,
    contextWindow: optionalBoolean(record.contextWindow),
    promptCacheKey: optionalBoolean(record.promptCacheKey),
    store: optionalBoolean(record.store),
    strictTools: optionalBoolean(record.strictTools),
    parallelToolCalls: optionalBoolean(record.parallelToolCalls),
    developerRole: optionalBoolean(record.developerRole),
    clientRequestId: optionalBoolean(record.clientRequestId),
    reasoningEfforts: reasoningEfforts?.length ? reasoningEfforts : undefined,
    defaultReasoningEffort,
  };
  return Object.values(result).some((entry) => entry !== undefined) ? result : undefined;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}