import type * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { enrichModelsWithOpenRouter, scheduleOpenRouterRefresh } from '../metadata/openrouterFallback';
import { RelayClient } from '../relay/client';
import { assignUniquePickerIds, filterModels, fromConfiguredModel, toRoutedModel } from '../relay/models';
import { normalizeOpenAIRequestCapabilities } from '../relay/openaiCapabilities';
import { normalizeClaudeRequestCapabilities } from '../relay/claudeCapabilities';
import type { ApiType, ModelMetadataSources, RoutedModel } from '../relay/types';
import { formatLogError, type DebugLogger } from './requestDiagnostics';

export interface ModelLoadResult {
  readonly models: RoutedModel[];
  readonly directory: RoutedModel[];
  readonly directoryError?: unknown;
}

/** Offline restore and online refresh share exactly the same catalog assembly. */
export function assembleModelCatalog(config: ExtensionConfig, directory: readonly RoutedModel[]): RoutedModel[] {
  const enrich = (models: RoutedModel[]) => config.modelMetadataEnabled ? enrichModelsWithOpenRouter(models) : models;
  const discovered = filterModels(enrich(applyDirectoryApiTypes(config, directory)), config);
  const configured = filterModels(enrich(config.models.map(model => fromConfiguredModel(model, config.apiType))), config);
  return assignUniquePickerIds(dedupeModels([...discovered, ...configured]));
}

/** Discovery only reads /models and replaces the directory on success. */
export async function loadAllModels(
  config: ExtensionConfig,
  apiKey: string | undefined,
  debug: DebugLogger,
  previousDirectory: readonly RoutedModel[] = [],
  token?: vscode.CancellationToken,
): Promise<ModelLoadResult> {
  if (config.modelMetadataEnabled) void scheduleOpenRouterRefresh(config.metadataRefreshHours * 3_600_000);
  let directory = [...previousDirectory];
  let directoryError: unknown;
  if (apiKey) {
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
      authScheme: config.apiType === 'messages' ? 'x-api-key' : 'bearer',
      anthropicVersion: config.anthropicVersion,
      requestTimeoutMs: config.requestTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });
    try {
      const response = await client.listModels(token);
      directory = applyDirectoryApiTypes(config, (response.data ?? []).map(model => toRoutedModel(model, config.apiType)));
    } catch (error) {
      if (token?.isCancellationRequested) throw error;
      directoryError = error;
      debug(config, `[models] directory unavailable; retaining the last catalog: ${formatLogError(error)}`);
    }
  }
  const models = assembleModelCatalog(config, directory);
  if (!models.length && directoryError) throw new Error('The Relay model directory could not be refreshed.');
  return { models, directory, ...(directoryError === undefined ? {} : { directoryError }) };
}

/** Older verified directories may contain only one of several explicitly declared APIs. */
function applyDirectoryApiTypes(config: ExtensionConfig, directory: readonly RoutedModel[]): RoutedModel[] {
  const declarations = new Map<string, Set<ApiType>>();
  for (const model of config.models) {
    const types = declarations.get(model.id) ?? new Set<ApiType>();
    types.add(model.apiType ?? config.apiType);
    declarations.set(model.id, types);
  }
  const groups = new Map<string, Map<ApiType, RoutedModel>>();
  for (const model of directory) {
    const variants = groups.get(model.upstreamId) ?? new Map<ApiType, RoutedModel>();
    const existing = variants.get(model.apiType);
    variants.set(model.apiType, existing ? mergeRoutedModels(existing, model) : model);
    groups.set(model.upstreamId, variants);
  }
  const result: RoutedModel[] = [];
  for (const [id, variants] of groups) {
    const fallback = variants.get(config.apiType) ?? variants.values().next().value!;
    for (const apiType of declarations.get(id) ?? variants.keys()) {
      // Re-read raw API metadata for the selected API while retaining normalized
      // capabilities from old snapshots that no longer carry their raw fields.
      result.push(variants.get(apiType) ?? mergeRoutedModels(
        { ...fallback, apiType },
        toRoutedModel(fallback, apiType),
      ));
    }
  }
  return result;
}

function dedupeModels(models: readonly RoutedModel[]): RoutedModel[] {
  const byKey = new Map<string, RoutedModel>();
  for (const model of models) {
    const key = `${model.apiType}:${model.upstreamId}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeRoutedModels(existing, model) : model);
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id) || a.apiType.localeCompare(b.apiType));
}

function mergeRoutedModels(existing: RoutedModel, override: RoutedModel): RoutedModel {
  const merged: RoutedModel = { ...existing, ...definedEntries(override) };
  if (existing.openai || override.openai) merged.openai = normalizeOpenAIRequestCapabilities({ ...existing.openai, ...definedEntries(override.openai ?? {}) });
  if (existing.claude || override.claude) merged.claude = normalizeClaudeRequestCapabilities({ ...existing.claude, ...definedEntries(override.claude ?? {}) });
  const sources: ModelMetadataSources = { ...existing.metadataSources };
  for (const key of ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'toolCalling', 'imageInput', 'thinking', 'referencePricing'] as const) {
    if (override[key] !== undefined) sources[key] = override.metadataSources?.[key];
  }
  merged.metadataSources = sources;
  return merged;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
