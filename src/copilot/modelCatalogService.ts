import type * as vscode from 'vscode';
import { getConfig } from '../config/config';
import type { ConnectionProfile, ExtensionConfig } from '../config/config';
import type { RoutedModel } from '../relay/types';
import { assembleModelCatalog, loadAllModels } from './modelRegistry';
import type { ModelLoadResult } from './modelRegistry';
import type { ModelSnapshotStore, ModelSnapshotRecord } from './modelSnapshotStore';
import { formatLogError, type DebugLogger } from './requestDiagnostics';

/** Single connection directory loading, assembly and credential-bound persistence. */
export class ModelCatalogService {
  constructor(private readonly snapshotStore: ModelSnapshotStore, private readonly debug: DebugLogger) {}

  load(config: ExtensionConfig, apiKey: string | undefined, previousDirectory: readonly RoutedModel[], token?: vscode.CancellationToken): Promise<ModelLoadResult> {
    return loadAllModels(config, apiKey, this.debug, previousDirectory, token);
  }
  assemble(config: ExtensionConfig, directory: readonly RoutedModel[]): RoutedModel[] {
    return assembleModelCatalog(config, directory);
  }
  restore(profileId: string, revision: string): ModelSnapshotRecord | undefined {
    return this.snapshotStore.get(profileId, revision);
  }
  async persistSnapshot(profileId: string, revision: string, directory: readonly RoutedModel[]): Promise<void> {
    try { await this.snapshotStore.update(profileId, revision, directory); }
    catch (error) { this.debug(getConfig(), `[models] connection=${profileId}, snapshot persist failed: ${formatLogError(error)}`); }
  }
  async clearSnapshot(profile: ConnectionProfile): Promise<void> {
    await this.deleteProfile(profile.id);
  }
  async deleteProfile(profileId: string): Promise<void> {
    try { await this.snapshotStore.deleteProfile(profileId); }
    catch (error) { this.debug(getConfig(), `[models] connection=${profileId}, snapshot clear failed: ${formatLogError(error)}`); }
  }
  async clearAll(): Promise<void> {
    try { await this.snapshotStore.clear(); }
    catch (error) { this.debug(getConfig(), `[models] snapshot store clear failed: ${formatLogError(error)}`); }
  }
}
