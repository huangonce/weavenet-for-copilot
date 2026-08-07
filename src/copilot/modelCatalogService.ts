import type * as vscode from 'vscode';
import { getConfig } from '../config/config';
import type { ConnectionProfile, ExtensionConfig } from '../config/config';
import type { RoutedModel } from '../relay/types';
import { loadAllModels } from './modelRegistry';
import type { ModelLoadResult } from './modelRegistry';
import type { ModelSnapshotStore } from './modelSnapshotStore';
import type { ModelSnapshotRecord } from './modelSnapshotStore';
import { formatLogError, type DebugLogger } from './requestDiagnostics';

/**
 * Loads and persists the model catalog for one connection. Keeps the Relay
 * `loadAllModels` orchestration and the snapshot store behind a single facade
 * so the runtime state machine never touches storage directly.
 */
export class ModelCatalogService {
  constructor(
    private readonly snapshotStore: ModelSnapshotStore,
    private readonly debug: DebugLogger,
  ) {}

  load(
    config: ExtensionConfig,
    apiKey: string | undefined,
    catalogRevision: string,
    previousSnapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]>,
    token?: vscode.CancellationToken,
    forceProbe = false,
  ): Promise<ModelLoadResult> {
    return loadAllModels(config, apiKey, catalogRevision, this.debug, previousSnapshots, token, forceProbe);
  }

  restore(profileId: string, catalogRevision: string): ModelSnapshotRecord | undefined {
    return this.snapshotStore.get(profileId, catalogRevision);
  }

  snapshotMap(record: ModelSnapshotRecord): Map<RoutedModel['route'], RoutedModel[]> {
    const map = new Map<RoutedModel['route'], RoutedModel[]>();
    for (const route of ['openai', 'chatgpt', 'claude'] as const) {
      if (record.snapshots[route].length > 0) map.set(route, record.snapshots[route]);
    }
    return map;
  }

  /** Persists the successful catalog; storage failures never affect refresh. */
  async persistSnapshot(
    profileId: string,
    catalogRevision: string,
    snapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]>,
    models: readonly RoutedModel[],
  ): Promise<void> {
    try {
      await this.snapshotStore.update(profileId, catalogRevision, snapshots, models);
    } catch (error) {
      this.debug(getConfig(), `[models] connection=${profileId}, snapshot persist failed: ${formatLogError(error)}`);
    }
  }

  async clearSnapshot(profile: ConnectionProfile): Promise<void> {
    try {
      await this.snapshotStore.deleteProfile(profile.id);
    } catch (error) {
      this.debug(getConfig(profile), `[models] connection=${profile.name}, snapshot clear failed: ${formatLogError(error)}`);
    }
  }

  async deleteProfile(profileId: string): Promise<void> {
    try {
      await this.snapshotStore.deleteProfile(profileId);
    } catch (error) {
      this.debug(getConfig(), `[models] connection=${profileId}, snapshot clear failed: ${formatLogError(error)}`);
    }
  }

  async clearAll(): Promise<void> {
    try {
      await this.snapshotStore.clear();
    } catch (error) {
      this.debug(getConfig(), `[models] snapshot store clear failed: ${formatLogError(error)}`);
    }
  }

  reportRouteRefreshFailure(config: ExtensionConfig, route: RoutedModel['route'], error: unknown): void {
    this.debug(config, `[models] ${route} route unavailable; continuing with successful routes: ${formatLogError(error)}`);
  }
}
