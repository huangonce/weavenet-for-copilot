import * as vscode from 'vscode';
import { AuthManager } from '../auth/auth';
import { getConfig, getProfileConfiguration } from '../config/config';
import type { ConfiguredModel, ConnectionProfile } from '../config/config';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  CONFIG_SECTION,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
  RELAY_API_KEY_SECRET,
} from '../constants';
import { RelayClient } from '../relay/client';
import type { RelayEndpointTestResult } from '../relay/client';
import { toChatInformation } from '../relay/models';
import type { ModelsResponse, RoutedModel } from '../relay/types';
import {
  ConnectionTestError,
  connectionErrorMessage,
  describeConnectionTestError,
  safeHost,
} from './connection';
import type { ConnectionTestFailure } from './connection';
import {
  deriveConnectionCapabilities,
  deriveDiagnosticsOverall,
} from './connectionDiagnostics';
import type {
  ConnectionDiagnosticsSnapshot,
  ConnectionProbeId,
  ConnectionProbeResult,
  ConnectionProbeVerdict,
} from './connectionDiagnostics';
import { ConnectionDiagnosticsStore, fingerprintConnection } from './connectionDiagnosticsStore';
import { estimateTextTokens } from './helpers';
import type { ModelOptions } from './helpers';
import { provideClaudeResponse } from './claudeResponse';
import { loadAllModels } from './modelRegistry';
import { provideOpenAIResponse } from './openaiResponse';
import { formatLogError } from './requestDiagnostics';

export {
  ConnectionTestError,
  describeConnectionTestError,
  safeEndpoint,
  safeHost,
  toLanguageModelError,
} from './connection';
export type { ConnectionTestFailure } from './connection';
export {
  estimateTextTokens,
  getConfiguredContextWindow,
  getConfiguredReasoningEffort,
  parseToolArguments,
  toClaudeThinking,
} from './helpers';

type ModelRefreshIntent = 'passive' | 'invalidate';

export interface ConnectionStatus {
  phase: 'unconfigured' | 'keyMissing' | 'refreshing' | 'ready' | 'degraded' | 'error';
  connectionCount: number;
  modelCount: number;
  warningCount: number;
  refreshingCount: number;
  connections: readonly ConnectionStatusEntry[];
  message?: string;
}

export interface ConnectionStatusEntry {
  profileId: string;
  connectionName: string;
  host?: string;
  phase: Exclude<ConnectionStatus['phase'], 'unconfigured'>;
  modelCount: number;
  modelRefreshedAt?: number;
  lastDiagnostics?: ConnectionDiagnosticsSnapshot;
  message?: string;
}

export type ConnectionTestResult = ConnectionDiagnosticsSnapshot;

interface ConnectionRuntime {
  profile: ConnectionProfile;
  revision: string;
  models: RoutedModel[];
  snapshots: Map<RoutedModel['route'], RoutedModel[]>;
  generation: number;
  resolved: boolean;
  phase: ConnectionStatusEntry['phase'];
  refreshedAt?: number;
  message?: string;
  lastDiagnostics?: ConnectionDiagnosticsSnapshot;
  refreshTask?: Promise<void>;
}

interface BoundModel {
  readonly profileId: string;
  readonly revision: string;
  readonly model: RoutedModel;
}

export class WeaveNetChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly connectionStatusEmitter = new vscode.EventEmitter<ConnectionStatus>();
  private readonly output = vscode.window.createOutputChannel('WeaveNet');
  private readonly auth: AuthManager;
  private readonly runtimes = new Map<string, ConnectionRuntime>();
  private readonly modelBindings = new Map<string, BoundModel>();
  private connectionStatus: ConnectionStatus = {
    phase: 'unconfigured', connectionCount: 0, modelCount: 0, warningCount: 0, refreshingCount: 0, connections: [],
  };
  private readonly diagnosticsStore: ConnectionDiagnosticsStore;
  private readonly connectionTestTasks = new Map<string, Promise<ConnectionTestResult>>();

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  readonly onDidChangeConnectionStatus = this.connectionStatusEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets);
    this.diagnosticsStore = new ConnectionDiagnosticsStore(context.globalState);
    this.syncProfiles();
    context.subscriptions.push(
      this.changeEmitter,
      this.connectionStatusEmitter,
      this.output,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          void this.reconcileConfiguration();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (isWeaveNetSecretKey(event.key)) {
          void this.handleSecretChange(event.key);
        }
      }),
    );
  }

  async promptForRelayKeyValue(profileName: string): Promise<string | undefined> {
    return this.auth.promptForApiKeyValue(profileName);
  }

  async storeRelayKey(profile: ConnectionProfile, apiKey: string): Promise<void> {
    await this.auth.storeApiKey(profile, apiKey);
  }

  async clearRelayKeyForProfile(profile: ConnectionProfile): Promise<void> {
    await this.auth.clearProfileApiKey(profile);
  }

  async clearAllRelayKeys(profiles: readonly ConnectionProfile[]): Promise<void> {
    await this.auth.clearAllRelayApiKeys(profiles);
  }

  async migrateRelayKeys(profiles: readonly ConnectionProfile[]): Promise<void> {
    await this.auth.migrateProfileApiKeys(profiles);
  }

  async clearConnectionDiagnostics(profile: ConnectionProfile): Promise<void> {
    await this.diagnosticsStore.delete(profile, diagnosticsOptions());
  }

  async clearAllConnectionDiagnostics(): Promise<void> {
    await this.diagnosticsStore.clear();
  }

  async testConnection(profile: ConnectionProfile): Promise<ConnectionTestResult> {
    const fingerprint = fingerprintConnection(profile, diagnosticsOptions());
    const existing = this.connectionTestTasks.get(fingerprint);
    if (existing) return existing;
    const task = this.runConnectionTest(profile, fingerprint).finally(() => {
      if (this.connectionTestTasks.get(fingerprint) === task) this.connectionTestTasks.delete(fingerprint);
    });
    this.connectionTestTasks.set(fingerprint, task);
    return task;
  }

  private async runConnectionTest(profile: ConnectionProfile, fingerprint: string): Promise<ConnectionTestResult> {
    const host = safeHost(profile.baseUrl) ?? 'unknown host';
    if (!safeHost(profile.baseUrl)) {
      throw new ConnectionTestError({ category: 'url', message: 'The Relay Base URL must be a valid http(s) URL.' });
    }
    const apiKey = await this.auth.getApiKey(profile);
    if (!apiKey) {
      this.setTestConnectionStatus(profile.id, fingerprint, { phase: 'keyMissing', message: 'API key is required.' });
      throw new ConnectionTestError({ category: 'authentication', message: 'API key is required for this connection.' });
    }
    const testedAt = Date.now();
    try {
      const config = getConfig(profile);
      const client = new RelayClient({
        baseUrl: profile.baseUrl,
        apiKey,
        requestHeaders: profile.requestHeaders ?? {},
        anthropicVersion: config.anthropicVersion,
        requestTimeoutMs: config.requestTimeoutMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      });
      const modelsStartedAt = Date.now();
      const { models, diagnostic } = await client.testModels();
      const modelCount = Array.isArray(models.data) ? models.data.length : 0;
      const probes: ConnectionProbeResult[] = [successfulProbe('models', modelsStartedAt, diagnostic)];
      const candidates = selectProbeCandidates(profile.models ?? [], models);
      if (candidates.openai) {
        const model = candidates.openai;
        probes.push(await runProtocolProbe('openai.nonStreaming', '/chat/completions', model, () => client.testOpenAIChatCompletion(model, false)));
        probes.push(await runProtocolProbe('openai.streaming', '/chat/completions', model, () => client.testOpenAIChatCompletion(model, true)));
      } else {
        probes.push(skippedProbe('openai.nonStreaming', '/chat/completions', 'noOpenAIModel'));
        probes.push(skippedProbe('openai.streaming', '/chat/completions', 'noOpenAIModel'));
      }
      if (candidates.claude) {
        const model = candidates.claude;
        probes.push(await runProtocolProbe('claude.nonStreaming', '/messages', model, () => client.testClaudeMessages(model, false)));
        probes.push(await runProtocolProbe('claude.streaming', '/messages', model, () => client.testClaudeMessages(model, true)));
      } else {
        probes.push(skippedProbe('claude.nonStreaming', '/messages', 'noClaudeModel'));
        probes.push(skippedProbe('claude.streaming', '/messages', 'noClaudeModel'));
      }
      const completedAt = Date.now();
      const result: ConnectionDiagnosticsSnapshot = {
        schemaVersion: 2,
        profileId: profile.id,
        fingerprint,
        connectionName: profile.name,
        host,
        testedAt,
        completedAt,
        elapsedMs: completedAt - testedAt,
        overall: deriveDiagnosticsOverall(probes),
        modelCount,
        capabilities: deriveConnectionCapabilities(probes),
        probes,
      };
      if (currentProfileFingerprint(profile.id) === fingerprint) {
        await this.diagnosticsStore.update(result);
        this.setTestConnectionStatus(profile.id, fingerprint, {
          phase: result.overall === 'success' ? 'ready' : 'degraded',
          lastDiagnostics: result,
          message: result.overall === 'degraded' ? 'Connection capabilities are partially available or unknown.' : undefined,
        });
      }
      return result;
    } catch (error) {
      const failure = describeConnectionTestError(error);
      this.setTestConnectionStatus(profile.id, fingerprint, { phase: 'error', message: failure.message });
      throw new ConnectionTestError(failure);
    }
  }

  async refreshModels(intent: ModelRefreshIntent = 'passive', notifySuccess = false): Promise<void> {
    const runtimes = this.syncProfiles();
    await mapWithConcurrency(runtimes, 3, async (runtime) => {
      await this.requestConnectionRefresh(runtime, intent === 'invalidate');
    });
    if (notifySuccess) this.showRefreshSummary();
  }

  async refreshConnection(profileId: string, force = true): Promise<void> {
    this.syncProfiles();
    const runtime = this.runtimes.get(profileId);
    if (runtime) await this.requestConnectionRefresh(runtime, force);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void token;
    try {
      await this.refreshModels('passive', options.silent === false);
    } catch (error) {
      this.debug(getConfig(), `Model picker refresh failed: ${formatLogError(error)}`);
    }
    const entries = [...this.modelBindings.values()];
    const keyStates = new Map<string, boolean>();
    await Promise.all([...new Set(entries.map(({ profileId }) => profileId))].map(async (profileId) => {
      const runtime = this.runtimes.get(profileId);
      if (!runtime) return;
      try {
        keyStates.set(profileId, await this.auth.hasApiKey(runtime.profile));
      } catch (error) {
        keyStates.set(profileId, false);
        this.debug(getConfig(runtime.profile), `[models] connection=${runtime.profile.name}, API key status read failed: ${formatLogError(error)}`);
      }
    }));
    return entries.flatMap(({ profileId, model }) => {
      const runtime = this.runtimes.get(profileId);
      if (!runtime) return [];
      return [toChatInformation(model, getConfig(runtime.profile), keyStates.get(profileId) === true, {
        name: runtime.profile.name,
        host: safeHost(runtime.profile.baseUrl),
      })];
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const binding = this.modelBindings.get(model.id);
    if (!binding) {
      throw new vscode.LanguageModelError(`Unknown WeaveNet model route: ${model.id}`);
    }
    const runtime = this.runtimes.get(binding.profileId);
    if (!runtime || runtime.revision !== binding.revision) {
      throw vscode.LanguageModelError.NotFound('This model connection changed. Refresh models and select it again.');
    }
    const currentProfile = getProfileConfiguration().profiles.find((profile) => profile.id === binding.profileId);
    if (!currentProfile || catalogRevision(currentProfile) !== binding.revision) {
      throw vscode.LanguageModelError.NotFound('This model connection is no longer available. Refresh models and select it again.');
    }
    const config = getConfig(currentProfile);
    const routedModel = binding.model;
    const apiKey = await this.auth.getApiKey(currentProfile);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(`The API key for “${currentProfile.name}” is not configured.`);
    }
    const context = {
      config,
      routedModel,
      model,
      messages,
      options,
      progress,
      token,
      apiKey,
      debug: this.debug.bind(this),
    };
    if (routedModel.protocol === 'claude') await provideClaudeResponse(context);
    else await provideOpenAIResponse(context);
  }

  showDebugLog(): void {
    this.output.show(true);
  }

  refreshModelPicker(): void {
    this.changeEmitter.fire();
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  logMetadata(message: string): void {
    this.debug(getConfig(), message);
  }

  private debug(config: ReturnType<typeof getConfig>, message: string): void {
    if (config.debug) {
      this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  }

  private reportRouteRefreshFailure(config: ReturnType<typeof getConfig>, route: RoutedModel['route'], error: unknown): void {
    this.debug(config, `[models] ${route} route unavailable; continuing with successful routes: ${formatLogError(error)}`);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') return estimateTextTokens(text);
    let tokens = 4;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) tokens += estimateTextTokens(part.value);
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        tokens += estimateTextTokens(part.name) + estimateTextTokens(JSON.stringify(part.input ?? {}));
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        tokens += estimateTextTokens(JSON.stringify(part.content));
      } else if (part instanceof vscode.LanguageModelDataPart) {
        tokens += Math.max(256, Math.ceil(part.data.byteLength / 768));
      }
    }
    return tokens;
  }

  private syncProfiles(): ConnectionRuntime[] {
    const profiles = getProfileConfiguration().profiles;
    const ids = new Set(profiles.map((profile) => profile.id));
    let changed = false;
    for (const [id, runtime] of this.runtimes) {
      if (ids.has(id)) continue;
      runtime.generation++;
      this.runtimes.delete(id);
      changed = true;
    }
    for (const profile of profiles) {
      const revision = catalogRevision(profile);
      const existing = this.runtimes.get(profile.id);
      if (!existing) {
        this.runtimes.set(profile.id, {
          profile, revision, models: [], snapshots: new Map(), generation: 0, resolved: false, phase: 'refreshing',
          lastDiagnostics: this.diagnosticsStore.get(profile, diagnosticsOptions()),
        });
        changed = true;
      } else if (existing.revision !== revision) {
        existing.generation++;
        existing.profile = profile;
        existing.revision = revision;
        existing.models = [];
        existing.snapshots.clear();
        existing.resolved = false;
        existing.phase = 'refreshing';
        existing.message = undefined;
        existing.lastDiagnostics = this.diagnosticsStore.get(profile, diagnosticsOptions());
        changed = true;
      } else if (JSON.stringify(existing.profile) !== JSON.stringify(profile)) {
        existing.profile = profile;
        changed = true;
      }
    }
    if (changed) this.rebuildAggregates();
    return profiles.map((profile) => this.runtimes.get(profile.id)).filter((runtime): runtime is ConnectionRuntime => Boolean(runtime));
  }

  private async reconcileConfiguration(): Promise<void> {
    const runtimes = this.syncProfiles().filter((runtime) => !runtime.resolved);
    if (runtimes.length) await mapWithConcurrency(runtimes, 3, (runtime) => this.requestConnectionRefresh(runtime, false));
    else this.changeEmitter.fire();
  }

  private requestConnectionRefresh(runtime: ConnectionRuntime, force: boolean): Promise<void> {
    if (force) {
      if (runtime.resolved || runtime.refreshTask) runtime.generation++;
      runtime.resolved = false;
    }
    if (runtime.resolved && !force) return Promise.resolve();
    if (runtime.refreshTask) return runtime.refreshTask;
    const task = Promise.resolve().then(() => this.refreshRuntimeUntilCurrent(runtime));
    const sharedTask = task.finally(() => {
      if (runtime.refreshTask === sharedTask) runtime.refreshTask = undefined;
    });
    runtime.refreshTask = sharedTask;
    return sharedTask;
  }

  private async refreshRuntimeUntilCurrent(runtime: ConnectionRuntime): Promise<void> {
    while (this.runtimes.get(runtime.profile.id) === runtime) {
      const generation = runtime.generation;
      await this.refreshRuntimeOnce(runtime, generation);
      if (runtime.generation === generation) return;
    }
  }

  private async refreshRuntimeOnce(runtime: ConnectionRuntime, generation: number): Promise<void> {
    const profile = runtime.profile;
    const revision = runtime.revision;
    let apiKey: string | undefined;
    try {
      apiKey = await this.auth.getApiKey(profile);
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      runtime.resolved = true;
      runtime.phase = runtime.models.length ? 'degraded' : 'error';
      runtime.message = `Could not read the API key: ${connectionErrorMessage(error)}`;
      runtime.refreshedAt = Date.now();
      this.debug(getConfig(profile), `[models] connection=${profile.name}, API key read failed: ${formatLogError(error)}`);
      this.rebuildAggregates();
      return;
    }
    if (!this.isCurrentRuntime(runtime, generation, revision)) return;
    if (!apiKey) {
      runtime.models = [];
      runtime.snapshots.clear();
      runtime.resolved = true;
      runtime.phase = 'keyMissing';
      runtime.message = 'API key required.';
      runtime.refreshedAt = Date.now();
      this.rebuildAggregates();
      return;
    }
    runtime.phase = 'refreshing';
    runtime.message = undefined;
    this.rebuildStatus();
    const config = getConfig(profile);
    try {
      const result = await loadAllModels(config, apiKey, this.debug.bind(this), new Map(runtime.snapshots));
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      runtime.models = result.models;
      runtime.snapshots = new Map(result.snapshots);
      runtime.resolved = true;
      runtime.phase = result.partial ? 'degraded' : 'ready';
      runtime.message = result.partial ? 'Some Relay model routes could not be refreshed.' : undefined;
      runtime.refreshedAt = Date.now();
      for (const failure of result.failedRoutes) this.reportRouteRefreshFailure(config, failure.route, failure.error);
    } catch (error) {
      if (!this.isCurrentRuntime(runtime, generation, revision)) return;
      runtime.resolved = true;
      runtime.phase = runtime.models.length ? 'degraded' : 'error';
      runtime.message = connectionErrorMessage(error);
      runtime.refreshedAt = Date.now();
      this.debug(config, `[models] connection=${profile.name}, refresh failed: ${formatLogError(error)}`);
    }
    this.rebuildAggregates();
  }

  private isCurrentRuntime(runtime: ConnectionRuntime, generation: number, revision: string): boolean {
    return this.runtimes.get(runtime.profile.id) === runtime && runtime.generation === generation && runtime.revision === revision;
  }

  private rebuildAggregates(): void {
    this.modelBindings.clear();
    for (const runtime of this.runtimes.values()) {
      for (const original of runtime.models) {
        const model = { ...original, pickerId: namespacedPickerId(runtime.profile.id, original.pickerId) };
        this.modelBindings.set(model.pickerId, { profileId: runtime.profile.id, revision: runtime.revision, model });
      }
    }
    this.rebuildStatus();
    this.changeEmitter.fire();
  }

  private rebuildStatus(): void {
    const connections: ConnectionStatusEntry[] = [...this.runtimes.values()].map((runtime) => ({
      profileId: runtime.profile.id,
      connectionName: runtime.profile.name,
      host: safeHost(runtime.profile.baseUrl),
      phase: runtime.phase,
      modelCount: runtime.models.length,
      modelRefreshedAt: runtime.refreshedAt,
      lastDiagnostics: runtime.lastDiagnostics,
      message: runtime.message,
    }));
    const modelCount = connections.reduce((total, connection) => total + connection.modelCount, 0);
    const refreshingCount = connections.filter((connection) => connection.phase === 'refreshing').length;
    const warningCount = connections.filter((connection) => connection.phase === 'keyMissing' || connection.phase === 'degraded' || connection.phase === 'error').length;
    let phase: ConnectionStatus['phase'];
    if (!connections.length) phase = 'unconfigured';
    else if (refreshingCount) phase = 'refreshing';
    else if (warningCount) phase = modelCount ? 'degraded' : connections.every((entry) => entry.phase === 'keyMissing') ? 'keyMissing' : 'error';
    else phase = 'ready';
    this.connectionStatus = { phase, connectionCount: connections.length, modelCount, warningCount, refreshingCount, connections };
    this.connectionStatusEmitter.fire(this.connectionStatus);
  }

  private setTestConnectionStatus(
    profileId: string,
    fingerprint: string,
    status: Pick<ConnectionRuntime, 'phase' | 'message' | 'lastDiagnostics'>,
  ): void {
    if (currentProfileFingerprint(profileId) !== fingerprint) return;
    const runtime = this.runtimes.get(profileId);
    if (!runtime) return;
    runtime.phase = status.phase;
    runtime.message = status.message;
    if (status.lastDiagnostics !== undefined) runtime.lastDiagnostics = status.lastDiagnostics;
    this.rebuildStatus();
  }

  private async handleSecretChange(secretKey: string): Promise<void> {
    this.syncProfiles();
    const profileId = profileIdFromSecretKey(secretKey) ?? profileIdFromLegacySecretKey(secretKey);
    if (!profileId) {
      await this.diagnosticsStore.clear();
      for (const runtime of this.runtimes.values()) {
        runtime.lastDiagnostics = undefined;
        runtime.generation++;
        runtime.resolved = false;
      }
      await this.refreshModels();
      return;
    }
    await this.diagnosticsStore.deleteProfile(profileId);
    const runtime = this.runtimes.get(profileId);
    if (!runtime) return;
    runtime.lastDiagnostics = undefined;
    runtime.generation++;
    runtime.resolved = false;
    await this.requestConnectionRefresh(runtime, false);
  }

  private showRefreshSummary(): void {
    const total = this.connectionStatus.connectionCount;
    const warnings = this.connectionStatus.warningCount;
    const healthy = total - warnings;
    void vscode.window.showInformationMessage(
      `WeaveNet loaded ${this.connectionStatus.modelCount} model(s) from ${healthy}/${total} connection(s)${warnings ? `; ${warnings} warning(s)` : ''}.`,
    );
  }
}

function catalogRevision(profile: ConnectionProfile): string {
  const config = getConfig(profile);
  return JSON.stringify({
    baseUrl: config.baseUrl,
    requestHeaders: config.requestHeaders,
    includeModels: config.includeModels.map((entry) => entry.source),
    excludeModels: config.excludeModels.map((entry) => entry.source),
    models: config.models,
  });
}

function namespacedPickerId(profileId: string, localPickerId: string): string {
  return `weavenet::${profileId}::${encodeURIComponent(localPickerId)}`;
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

function diagnosticsOptions(): { anthropicVersion: string } {
  return { anthropicVersion: getConfig().anthropicVersion };
}

function currentProfileFingerprint(profileId: string): string | undefined {
  const profile = getProfileConfiguration().profiles.find((entry) => entry.id === profileId);
  return profile ? fingerprintConnection(profile, diagnosticsOptions()) : undefined;
}

function selectProbeCandidates(
  configured: readonly ConfiguredModel[],
  models: ModelsResponse,
): { openai?: string; claude?: string } {
  const explicitOpenAI = configured.find((model) => model.route === 'openai' || model.route === 'chatgpt')?.id;
  const explicitClaude = configured.find((model) => model.route === 'claude')?.id;
  const catalog = models.data ?? [];
  const claude = explicitClaude ?? catalog.find((model) => isClaudeModel(model.id))?.id;
  const openai = explicitOpenAI ?? catalog.find((model) => model.id !== claude && !isClaudeModel(model.id))?.id;
  return { openai, claude };
}

function successfulProbe(
  probe: ConnectionProbeId,
  startedAt: number,
  diagnostic: RelayEndpointTestResult,
  evidenceModelId?: string,
): ConnectionProbeResult {
  return {
    probe,
    verdict: 'supported',
    endpointPath: diagnostic.endpoint,
    startedAt,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    status: diagnostic.status,
    responseType: diagnostic.responseType,
    requestId: diagnostic.requestId,
    evidenceModelId,
    termination: diagnostic.termination,
  };
}

async function runProtocolProbe(
  probe: ConnectionProbeId,
  endpointPath: '/chat/completions' | '/messages',
  evidenceModelId: string,
  operation: () => Promise<RelayEndpointTestResult>,
): Promise<ConnectionProbeResult> {
  const startedAt = Date.now();
  try {
    return successfulProbe(probe, startedAt, await operation(), evidenceModelId);
  } catch (error) {
    const failure = describeConnectionTestError(error);
    return {
      probe,
      verdict: probeVerdictForFailure(failure),
      endpointPath,
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      status: failure.status,
      responseType: failure.responseType,
      requestId: failure.requestId,
      evidenceModelId,
      failure,
    };
  }
}

function probeVerdictForFailure(failure: ConnectionTestFailure): ConnectionProbeVerdict {
  return failure.category === 'notFound' ? 'unsupported' : 'indeterminate';
}

function skippedProbe(
  probe: ConnectionProbeId,
  endpointPath: '/chat/completions' | '/messages',
  skippedReason: 'noOpenAIModel' | 'noClaudeModel',
): ConnectionProbeResult {
  return { probe, verdict: 'skipped', endpointPath, startedAt: Date.now(), elapsedMs: 0, skippedReason };
}

function profileIdFromSecretKey(key: string): string | undefined {
  const prefix = `${RELAY_API_KEY_SECRET}.profileId.`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function profileIdFromLegacySecretKey(key: string): string | undefined {
  const prefix = `${RELAY_API_KEY_SECRET}.profile.`;
  if (!key.startsWith(prefix)) return undefined;
  try {
    const name = decodeURIComponent(key.slice(prefix.length));
    return getProfileConfiguration().profiles.find((profile) => profile.name === name)?.id;
  }
  catch { return undefined; }
}

function isWeaveNetSecretKey(key: string): boolean {
  return key === RELAY_API_KEY_SECRET || key.startsWith(`${RELAY_API_KEY_SECRET}.profile.`) ||
    key.startsWith(`${RELAY_API_KEY_SECRET}.profileId.`) || key === LEGACY_API_KEY_SECRET || [
    OPENAI_API_KEY_SECRET,
    CHATGPT_API_KEY_SECRET,
    CLAUDE_API_KEY_SECRET,
  ].some((secretKey) => key === secretKey);
}

// Protocol request handling lives in openaiResponse.ts and claudeResponse.ts.
