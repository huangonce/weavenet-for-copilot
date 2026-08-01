import type * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { enrichModelsWithOpenRouter, scheduleOpenRouterRefresh } from '../metadata/openrouterFallback';
import { RelayClient } from '../relay/client';
import { RelayRequestError } from '../relay/errors';
import {
  assignUniquePickerIds,
  filterModels,
  fromConfiguredModel,
  isClaudeModelId,
  toRoutedModel,
} from '../relay/models';
import { responsesProbeCache } from '../relay/responsesProbeCache';
import type { ResponsesEndpointAvailability } from '../relay/probes';
import type { ModelProtocol, RelayModel, RoutedModel } from '../relay/types';
import { formatLogError, type DebugLogger } from './requestDiagnostics';

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
  forceProbe = false,
): Promise<ModelLoadResult> {
  void scheduleOpenRouterRefresh(config.metadataRefreshHours * 3_600_000);

  const routes: Array<{ readonly name: RoutedModel['route']; readonly task: Promise<RoutedModel[]> }> = [];
  if (apiKey) {
    routes.push({
      name: 'openai',
      task: loadModelsForProtocol('openai', 'openai', apiKey, config, debug, token, forceProbe),
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

  loaded.push(...filterModels(enrichModelsWithOpenRouter(config.models.map(fromConfiguredModel)), config));
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
  forceProbe = false,
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
    toRoutedModel(model, isClaudeModelId(model.id) ? 'claude' : 'openai', route));
  // A shared /models catalog may advertise both OpenAI-compatible and native
  // Claude models. Route selection happens per model ID above.
  const filtered = filterModels(enrichModelsWithOpenRouter(routed), config);
  const withResponsesProbe = await applyResponsesProtocolProbes(client, filtered, config, debug, token, forceProbe);
  debug(config, `[models] loaded: protocol=${protocol}, count=${withResponsesProbe.length}, elapsedMs=${Date.now() - startedAt}`);
  return withResponsesProbe;
}

/**
 * Two-layer Responses capability detection, run on every model load/refresh.
 * The free `GET /responses` check short-circuits relays that do not implement
 * the endpoint (404) so no paid POST is ever issued. Remaining uncached OpenAI
 * models get one minimal `POST /responses` probe each (concurrency-bounded,
 * deduplicated by model id); results are cached per profile for
 * `metadataRefreshHours`. Only definitive rejections (HTTP 400/404/426) are
 * cached as unsupported; transient failures stay uncached so the next refresh
 * retries. `forceProbe` (user-invoked refresh) drops the profile's cached
 * verdicts first. Claude models are never probed.
 */
async function applyResponsesProtocolProbes(
  client: RelayClient,
  models: RoutedModel[],
  config: ExtensionConfig,
  debug: DebugLogger,
  token?: vscode.CancellationToken,
  forceProbe = false,
): Promise<RoutedModel[]> {
  const openaiModels = models.filter((model) => model.route !== 'claude' && !isClaudeModelId(model.upstreamId));
  if (openaiModels.length === 0) return models;

  const ttlMs = config.metadataRefreshHours * 3_600_000;
  if (forceProbe) responsesProbeCache.clearProfile(config.profileId);

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

  // The catalog may list the same model id more than once; probe each unique
  // id so one model never pays for parallel duplicate POSTs.
  const uniqueModels = [...new Map(openaiModels.map((model) => [model.upstreamId, model])).values()];
  const uncached = uniqueModels.filter(
    (model) => responsesProbeCache.get(config.profileId, model.upstreamId) === undefined,
  );
  const probed = new Map<string, 'chat' | 'responses'>();
  await mapWithConcurrency(uncached, RESPONSES_PROBE_CONCURRENCY, async (model) => {
    try {
      await client.testOpenAIResponses(model.upstreamId, false, token);
      probed.set(model.upstreamId, 'responses');
      responsesProbeCache.set(config.profileId, model.upstreamId, 'responses', ttlMs);
    } catch (error) {
      if (isDefinitiveProbeFailure(error)) {
        probed.set(model.upstreamId, 'chat');
        responsesProbeCache.set(config.profileId, model.upstreamId, 'chat', ttlMs);
        debug(config, `[models] model=${model.upstreamId} does not support /responses: ${formatLogError(error)}`);
      } else {
        // Transient failures (timeouts, 429/5xx, network, cancellation) are
        // not cached, so a later refresh retries instead of pinning chat.
        debug(config, `[models] model=${model.upstreamId} /responses probe transient failure: ${formatLogError(error)}`);
      }
    }
  });

  const openaiById = new Set(openaiModels.map((model) => model.upstreamId));
  let responsesCount = 0;
  const withApi = models.map((model) => {
    if (!openaiById.has(model.upstreamId)) return model;
    const verdict = responsesProbeCache.get(config.profileId, model.upstreamId) ?? probed.get(model.upstreamId) ?? 'chat';
    if (verdict !== 'responses') return model;
    responsesCount++;
    return { ...model, openaiApi: 'responses' as const };
  });
  if (responsesCount > 0) {
    debug(config, `[models] ${responsesCount}/${openaiModels.length} OpenAI models support /responses`);
  }
  return withApi;
}

/** Only explicit HTTP rejections settle the verdict; transient errors do not. */
function isDefinitiveProbeFailure(error: unknown): boolean {
  return error instanceof RelayRequestError
    && (error.status === 400 || error.status === 404 || error.status === 426);
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

/**
 * 去重只按目录分组（`route`）与 `upstreamId` 隔离——同一模型 id 可以同时以
 * OpenAI 兼容和 Claude 原生两种身份存在。请求分派维度（`protocol` +
 * `openaiApi`）不参与去重：合并时后出现的模型覆盖能力元数据，`openaiApi`
 * 取显式声明优先、否则保留探测结论。
 */
function dedupeModels(models: RoutedModel[]): RoutedModel[] {
  const byKey = new Map<string, RoutedModel>();
  for (const model of models) {
    const key = `${model.route}:${model.upstreamId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, model);
      continue;
    }
    // Explicitly configured models override discovery metadata. A fixed model
    // that declares `openaiApi` decides its own protocol; otherwise the
    // discovery probe verdict survives so dispatch keeps using Responses.
    byKey.set(key, {
      ...existing,
      ...model,
      openaiApi: model.openaiApi ?? existing.openaiApi,
    });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.protocol !== b.protocol) return a.protocol === 'openai' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
