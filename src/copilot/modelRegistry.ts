import type * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { scheduleOpenRouterRefresh } from '../metadata/openrouterFallback';
import { RelayClient } from '../relay/client';
import {
  assignUniquePickerIds,
  enrichModelsWithMetadata,
  filterModels,
  fromConfiguredModel,
  toRoutedModel,
} from '../relay/models';
import { ResponsesProbeCache } from '../relay/responsesProbeCache';
import type { ResponsesEndpointAvailability } from '../relay/probes';
import type { ModelProtocol, RelayModel, RoutedModel } from '../relay/types';
import { formatLogError, type DebugLogger } from './requestDiagnostics';

/** Probing verdict cache keyed by model id plus relay base URL. */
const responsesProbeCache = new ResponsesProbeCache();

const RESPONSES_PROBE_CONCURRENCY = 4;

export interface ModelLoadResult {
  readonly models: RoutedModel[];
  readonly snapshots: Map<RoutedModel['route'], RoutedModel[]>;
  readonly partial: boolean;
  readonly failedRoutes: Array<{ route: RoutedModel['route']; error: unknown }>;
}

export async function loadAllModels(
  config: ExtensionConfig,
  apiKey: string | undefined,
  debug: DebugLogger,
  previousSnapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]> = new Map(),
  token?: vscode.CancellationToken,
): Promise<ModelLoadResult> {
  void scheduleOpenRouterRefresh(config.metadataRefreshHours * 3_600_000);

  const routes: Array<{ readonly name: RoutedModel['route']; readonly task: Promise<RoutedModel[]> }> = [];
  if (apiKey) {
    routes.push({
      name: 'openai',
      task: loadModelsForProtocol('openai', 'openai', apiKey, config, debug, token),
    });
  }

  const results = await Promise.allSettled(routes.map((route) => route.task));
  const loaded: RoutedModel[] = [];
  const snapshots = new Map(previousSnapshots);
  const failedRoutes: Array<{ route: RoutedModel['route']; error: unknown }> = [];
  let failedRouteCount = 0;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const route = routes[index].name;
    if (result.status === 'fulfilled') {
      snapshots.set(route, result.value);
      loaded.push(...result.value);
    } else {
      failedRouteCount++;
      failedRoutes.push({ route, error: result.reason });
      loaded.push(...(snapshots.get(route) ?? []));
    }
  }

  loaded.push(...filterModels(enrichModelsWithMetadata(config.models.map(fromConfiguredModel)), config));
  if (!loaded.length && routes.length > 0 && failedRouteCount === routes.length) {
    throw new Error('All model routes failed to refresh.');
  }

  return {
    models: assignUniquePickerIds(dedupeModels(loaded)),
    snapshots,
    partial: failedRouteCount > 0,
    failedRoutes,
  };
}

async function loadModelsForProtocol(
  protocol: ModelProtocol,
  route: RoutedModel['route'],
  apiKey: string,
  config: ExtensionConfig,
  debug: DebugLogger,
  token?: vscode.CancellationToken,
): Promise<RoutedModel[]> {
  const startedAt = Date.now();
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    authScheme: protocol === 'claude' ? 'x-api-key' : 'bearer',
    anthropicVersion: config.anthropicVersion,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });
  const response = await client.listModels(token);
  const routed = (response.data ?? []).map((model: RelayModel) =>
    toRoutedModel(model, isClaudeModel(model.id) ? 'claude' : 'openai', route));
  // A shared /models catalog may advertise both OpenAI-compatible and native
  // Claude models. Route selection happens per model ID above.
  const filtered = filterModels(enrichModelsWithMetadata(routed), config);
  const withResponsesProbe = await applyResponsesProtocolProbes(client, filtered, config, debug, token);
  debug(config, `Models loaded: protocol=${protocol}, count=${withResponsesProbe.length}, elapsedMs=${Date.now() - startedAt}`);
  return withResponsesProbe;
}

/**
 * Two-layer Responses capability detection, run only during user-triggered
 * model load/refresh. The free `GET /responses` check short-circuits relays
 * that do not implement the endpoint (404/405) so no paid POST is ever issued.
 * Remaining uncached OpenAI models get one minimal `POST /responses` probe each
 * (concurrency-bounded); results are cached for `metadataRefreshHours`. Claude
 * models and explicitly configured fixed models are never probed.
 */
async function applyResponsesProtocolProbes(
  client: RelayClient,
  models: RoutedModel[],
  config: ExtensionConfig,
  debug: DebugLogger,
  token?: vscode.CancellationToken,
): Promise<RoutedModel[]> {
  const openaiModels = models.filter((model) => model.route !== 'claude' && !isClaudeModel(model.upstreamId));
  if (openaiModels.length === 0) return models;

  const connectionKey = config.baseUrl;
  const ttlMs = config.metadataRefreshHours * 3_600_000;

  let endpointAvailable: ResponsesEndpointAvailability;
  try {
    endpointAvailable = await client.probeResponsesEndpoint(token);
  } catch (error) {
    endpointAvailable = 'unknown';
    debug(config, `[models] /responses endpoint probe failed: ${formatLogError(error)}`);
  }
  if (endpointAvailable === 'unsupported') {
    debug(config, '[models] /responses endpoint unsupported; OpenAI models keep chat completions');
    return models;
  }

  const uncached = openaiModels.filter(
    (model) => responsesProbeCache.get(model.upstreamId, connectionKey) === undefined,
  );
  const probed = new Map<string, 'chat' | 'responses'>();
  await mapWithConcurrency(uncached, RESPONSES_PROBE_CONCURRENCY, async (model) => {
    try {
      await client.testOpenAIResponses(model.upstreamId, false, token);
      probed.set(model.upstreamId, 'responses');
      responsesProbeCache.set(model.upstreamId, connectionKey, 'responses', ttlMs);
    } catch (error) {
      probed.set(model.upstreamId, 'chat');
      responsesProbeCache.set(model.upstreamId, connectionKey, 'chat', ttlMs);
      debug(config, `[models] model=${model.upstreamId} does not support /responses: ${formatLogError(error)}`);
    }
  });

  const openaiById = new Set(openaiModels.map((model) => model.upstreamId));
  let responsesCount = 0;
  const withApi = models.map((model) => {
    if (!openaiById.has(model.upstreamId)) return model;
    const verdict = responsesProbeCache.get(model.upstreamId, connectionKey) ?? probed.get(model.upstreamId) ?? 'chat';
    if (verdict !== 'responses') return model;
    responsesCount++;
    return { ...model, openaiApi: 'responses' as const };
  });
  if (responsesCount > 0) {
    debug(config, `[models] ${responsesCount}/${openaiModels.length} OpenAI models support /responses`);
  }
  return withApi;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const value = values[next++];
      await operation(value);
    }
  });
  await Promise.all(workers);
}

function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('claude-');
}

function dedupeModels(models: RoutedModel[]): RoutedModel[] {
  const byKey = new Map<string, RoutedModel>();
  for (const model of models) byKey.set(`${model.route}:${model.upstreamId}`, model);
  return [...byKey.values()].sort((a, b) => {
    if (a.protocol !== b.protocol) return a.protocol === 'openai' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
