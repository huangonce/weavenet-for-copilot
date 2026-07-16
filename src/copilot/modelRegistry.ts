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
import type { ModelProtocol, RelayModel, RoutedModel } from '../relay/types';
import type { DebugLogger } from './requestDiagnostics';

export interface ModelLoadResult {
  readonly models: RoutedModel[];
  readonly snapshots: Map<RoutedModel['route'], RoutedModel[]>;
  readonly partial: boolean;
  readonly failedRoutes: Array<{ route: RoutedModel['route']; error: unknown }>;
}

export async function loadAllModels(
  config: ExtensionConfig,
  getApiKey: (profileName?: string) => Promise<string | undefined>,
  debug: DebugLogger,
  previousSnapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]> = new Map(),
  token?: vscode.CancellationToken,
): Promise<ModelLoadResult> {
  void scheduleOpenRouterRefresh(config.metadataRefreshHours * 3_600_000);

  const apiKey = await getApiKey(config.profileName);
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
  debug(config, `Models loaded: protocol=${protocol}, count=${filtered.length}, elapsedMs=${Date.now() - startedAt}`);
  return filtered;
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
