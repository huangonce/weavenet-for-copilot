import type {
  ModelMetadataSource,
  ModelMetadataSources,
  ReferencePricing,
  RoutedModel,
} from '../relay/types.js';
import { getCachedData, scheduleRefresh } from './metadataCache.js';

/**
 * Runtime metadata layer backed by OpenRouter's public model catalog.
 * Matching is intentionally exact and conservative: relay metadata wins, and
 * OpenRouter only fills fields that the relay did not provide.
 */

export const OPENROUTER_CACHE_KEY = 'weavenet.metadata.openrouter.v3';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  readonly id?: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly architecture?: {
    readonly input_modalities?: readonly string[];
    readonly output_modalities?: readonly string[];
  };
  readonly supported_parameters?: readonly string[];
  readonly top_provider?: {
    readonly context_length?: number;
    readonly max_completion_tokens?: number;
  };
  readonly pricing?: {
    readonly prompt?: string;
    readonly completion?: string;
    readonly input_cache_read?: string;
    readonly input_cache_write?: string;
  };
}

interface OpenRouterResponse {
  readonly data?: readonly OpenRouterModel[];
}

interface OpenRouterCatalogEntry {
  readonly id: string;
  readonly fullId: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly vision?: boolean;
  readonly toolCalling?: boolean;
  readonly reasoning?: boolean;
  readonly referencePricing?: ReferencePricing;
}

/**
 * Schedules a fire-and-forget background refresh of the OpenRouter catalog.
 *
 * Safe to call on every `listModels()`; the cache layer enforces TTL and
 * coalesces concurrent calls. Pass `force = true` to bypass TTL/ETag for a
 * user-initiated full refresh; returns the inflight Promise when a fetch is
 * actually performed.
 */
export function scheduleOpenRouterRefresh(ttlMs: number, force = false): Promise<void> | undefined {
  return scheduleRefresh<OpenRouterCatalogEntry[]>(
    {
      key: OPENROUTER_CACHE_KEY,
      url: OPENROUTER_API_URL,
      ttlMs,
      label: 'openrouter',
      parse: (body) => parseOpenRouterResponse(JSON.parse(body) as OpenRouterResponse),
    },
    { force },
  );
}

/**
 * Normalizes the OpenRouter API response into our compact entry shape.
 *
 * Each OpenRouter model id looks like `vendor/model-name`; we strip the
 * vendor prefix because AIXRouter's own model ids are already vendor-agnostic
 * (e.g. `claude-sonnet-4.6`). We also keep the original full id as a second
 * entry so id-based exact matches still work for ambiguous names.
 */
export function parseOpenRouterResponse(payload: OpenRouterResponse): OpenRouterCatalogEntry[] {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const entries: OpenRouterCatalogEntry[] = [];

  for (const m of models) {
    if (!m?.id || typeof m.id !== 'string') continue;
    const entry = toEntry(m);
    if (entry) entries.push(entry);
  }

  return entries;
}

function stripVendor(fullId: string): string {
  const slash = fullId.lastIndexOf('/');
  return slash >= 0 ? fullId.slice(slash + 1) : fullId;
}

function toEntry(model: OpenRouterModel): OpenRouterCatalogEntry | undefined {
  const fullId = model.id?.trim();
  const id = fullId ? stripVendor(fullId) : '';
  if (!id) return undefined;
  const params = new Set(model.supported_parameters ?? []);
  const inputModalities = new Set(model.architecture?.input_modalities ?? []);
  const maxInputTokens =
    model.top_provider?.context_length ?? model.context_length ?? undefined;
  const maxOutputTokens = model.top_provider?.max_completion_tokens ?? undefined;
  return {
    id,
    fullId: fullId!,
    maxInputTokens,
    maxOutputTokens,
    vision: inputModalities.has('image') ? true : undefined,
    toolCalling: params.has('tools') || params.has('tool_choice') ? true : undefined,
    reasoning:
      params.has('reasoning') || params.has('reasoning_effort') || params.has('include_reasoning')
        ? true
        : undefined,
    referencePricing: toReferencePricing(model.pricing),
  };
}

function toReferencePricing(pricing: OpenRouterModel['pricing']): ReferencePricing | undefined {
  if (!pricing) return undefined;
  const perMillion = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
  };
  const inputPer1M = perMillion(pricing.prompt);
  const outputPer1M = perMillion(pricing.completion);
  const cacheHitPer1M = perMillion(pricing.input_cache_read);
  const cacheCreationPer1M = perMillion(pricing.input_cache_write);
  if (inputPer1M === undefined && outputPer1M === undefined && cacheHitPer1M === undefined && cacheCreationPer1M === undefined) {
    return undefined;
  }
  return { currencyCode: 'USD', inputPer1M, outputPer1M, cacheHitPer1M, cacheCreationPer1M };
}

/**
 * Batch-enriches a model list with cached OpenRouter data.
 *
 * Returns the original list untouched if the cache has never been populated.
 */
export function enrichModelsWithOpenRouter(models: RoutedModel[]): RoutedModel[] {
  const entries = getCachedData<OpenRouterCatalogEntry[]>(OPENROUTER_CACHE_KEY);
  if (!entries || entries.length === 0) return models;
  return models.map((model) => enrichModelFromOpenRouter(model, entries));
}

function enrichModelFromOpenRouter(
  model: RoutedModel,
  entries: readonly OpenRouterCatalogEntry[],
): RoutedModel {
  const modelId = model.id.toLowerCase();
  const entry = entries.find((candidate) => candidate.fullId.toLowerCase() === modelId)
    ?? entries.find((candidate) => candidate.id.toLowerCase() === modelId);
  if (!entry) return model;

  const maxInputTokens = model.maxInputTokens ?? entry.maxInputTokens;
  const maxOutputTokens = model.maxOutputTokens ?? entry.maxOutputTokens;
  const imageInput = model.imageInput ?? entry.vision;
  const toolCalling = model.toolCalling ?? entry.toolCalling;
  const thinking = model.thinking ?? entry.reasoning;
  const referencePricing = model.referencePricing ?? entry.referencePricing;
  const contextWindows = model.contextWindows?.length
    ? model.contextWindows
    : contextWindowsFromLimit(maxInputTokens);
  const tier: ModelMetadataSource = 'openrouter';

  const sources: ModelMetadataSources = {
    ...model.metadataSources,
    maxInputTokens: sourceForMissing(model.metadataSources?.maxInputTokens, tier, model.maxInputTokens, entry.maxInputTokens),
    maxOutputTokens: sourceForMissing(model.metadataSources?.maxOutputTokens, tier, model.maxOutputTokens, entry.maxOutputTokens),
    imageInput: sourceForMissing(model.metadataSources?.imageInput, tier, model.imageInput, entry.vision),
    toolCalling: sourceForMissing(model.metadataSources?.toolCalling, tier, model.toolCalling, entry.toolCalling),
    thinking: sourceForMissing(model.metadataSources?.thinking, tier, model.thinking, entry.reasoning),
    referencePricing: sourceForMissing(model.metadataSources?.referencePricing, tier, model.referencePricing, entry.referencePricing),
    contextWindows: model.contextWindows?.length
      ? model.metadataSources?.contextWindows
      : contextWindows?.length ? tier : undefined,
  };

  return {
    ...model,
    maxInputTokens,
    maxOutputTokens,
    imageInput,
    toolCalling,
    thinking,
    referencePricing,
    contextWindows,
    metadataSources: sources,
  };
}

function sourceForMissing<T>(
  currentSource: ModelMetadataSource | undefined,
  fallbackSource: ModelMetadataSource,
  currentValue: T | undefined,
  fallbackValue: T | undefined,
): ModelMetadataSource | undefined {
  return currentValue === undefined && fallbackValue !== undefined ? fallbackSource : currentSource;
}

function contextWindowsFromLimit(maxInputTokens: number | undefined): number[] | undefined {
  if (maxInputTokens === undefined) return undefined;
  const windows = [200_000, 400_000, 1_000_000].filter((value) => value <= maxInputTokens);
  return windows.length > 0 ? windows : undefined;
}
