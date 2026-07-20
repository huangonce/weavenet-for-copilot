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
  shouldApplyTestConnectionStatus,
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

export function shouldInvalidateModelRefresh(
  intent: ModelRefreshIntent,
  taskConnectionKey: string | undefined,
  connectionKey: string,
): boolean {
  return intent === 'invalidate' || taskConnectionKey !== connectionKey;
}

export interface ConnectionStatus {
  connectionName?: string;
  host?: string;
  phase: 'unconfigured' | 'keyMissing' | 'refreshing' | 'ready' | 'degraded' | 'error';
  modelCount: number;
  modelRefreshedAt?: number;
  lastDiagnostics?: ConnectionDiagnosticsSnapshot;
  message?: string;
}

export type ConnectionTestResult = ConnectionDiagnosticsSnapshot;

export class WeaveNetChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly connectionStatusEmitter = new vscode.EventEmitter<ConnectionStatus>();
  private readonly output = vscode.window.createOutputChannel('WeaveNet');
  private readonly auth: AuthManager;
  private cachedModels: RoutedModel[] = [];
  private readonly routeModelSnapshots = new Map<RoutedModel['route'], RoutedModel[]>();
  private refreshModelsTask: Promise<void> | undefined;
  private modelRefreshGeneration = 0;
  private refreshTaskConnectionKey: string | undefined;
  private cacheConnectionKey: string | undefined;
  private resolvedCatalogConnectionKey: string | undefined;
  private refreshNotification: { connectionKey: string; generation: number } | undefined;
  private connectionStatus: ConnectionStatus = { phase: 'unconfigured', modelCount: 0 };
  private readonly diagnosticsStore: ConnectionDiagnosticsStore;
  private readonly connectionTestTasks = new Map<string, Promise<ConnectionTestResult>>();

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  readonly onDidChangeConnectionStatus = this.connectionStatusEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets);
    this.diagnosticsStore = new ConnectionDiagnosticsStore(context.globalState);
    this.restoreActiveDiagnostics();
    context.subscriptions.push(
      this.changeEmitter,
      this.connectionStatusEmitter,
      this.output,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          void this.refreshModels('invalidate');
        }
      }),
      context.secrets.onDidChange((event) => {
        if (isWeaveNetSecretKey(event.key)) {
          void this.invalidateDiagnosticsForSecret(event.key);
          void this.refreshModels('invalidate');
        }
      }),
    );
  }

  async configureRelayKey(): Promise<void> {
    if (await this.promptForRelayKey(getConfig().profileName)) {
      await this.refreshModels('invalidate');
    }
  }

  async promptForRelayKey(profileName?: string): Promise<boolean> {
    return this.auth.promptForApiKey(profileName);
  }

  async promptForRelayKeyValue(profileName?: string): Promise<string | undefined> {
    return this.auth.promptForApiKeyValue(profileName);
  }

  async storeRelayKey(profileName: string, apiKey: string): Promise<void> {
    await this.auth.storeApiKey(profileName, apiKey);
  }

  async hasRelayKey(profileName?: string): Promise<boolean> {
    return this.auth.hasApiKey(profileName);
  }

  async moveRelayKey(fromProfileName: string | undefined, toProfileName: string): Promise<boolean> {
    return this.auth.moveApiKey(fromProfileName, toProfileName);
  }

  async clearRelayKey(): Promise<void> {
    await this.auth.clearApiKey(getConfig().profileName);
    await this.refreshModels();
  }

  async clearRelayKeyForProfile(profileName: string): Promise<void> {
    await this.auth.clearProfileApiKey(profileName);
  }

  async clearAllRelayKeys(profileNames: readonly string[]): Promise<void> {
    await this.auth.clearAllRelayApiKeys(profileNames);
  }

  getConnectionDiagnostics(profile: ConnectionProfile): ConnectionDiagnosticsSnapshot | undefined {
    return this.diagnosticsStore.get(profile, diagnosticsOptions());
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
    const apiKey = await this.auth.getApiKey(profile.name);
    if (!apiKey) {
      this.setTestConnectionStatus(fingerprint, { connectionName: profile.name, host, phase: 'keyMissing', modelCount: 0 });
      throw new ConnectionTestError({ category: 'authentication', message: 'API key is required for this connection.' });
    }
    const testedAt = Date.now();
    try {
      const config = getConfig();
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
        schemaVersion: 1,
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
      if (currentProfileFingerprint(profile.name) === fingerprint) {
        await this.diagnosticsStore.update(result);
        this.setTestConnectionStatus(fingerprint, {
          connectionName: profile.name,
          host,
          phase: result.overall === 'success' ? 'ready' : 'degraded',
          modelCount,
          lastDiagnostics: result,
          message: result.overall === 'degraded' ? 'Connection capabilities are partially available or unknown.' : undefined,
        });
      }
      return result;
    } catch (error) {
      const failure = describeConnectionTestError(error);
      this.setTestConnectionStatus(fingerprint, { connectionName: profile.name, host, phase: 'error', modelCount: 0, message: failure.message });
      throw new ConnectionTestError(failure);
    }
  }

  async refreshModels(intent: ModelRefreshIntent = 'passive', notifySuccess = false): Promise<void> {
    const config = getConfig();
    const connectionKey = modelConnectionKey(config);
    const connectionChanged = connectionKey !== this.cacheConnectionKey;
    if (intent === 'invalidate') this.resolvedCatalogConnectionKey = undefined;
    if (connectionChanged) {
      this.cachedModels = [];
      this.routeModelSnapshots.clear();
      this.cacheConnectionKey = connectionKey;
      this.resolvedCatalogConnectionKey = undefined;
      this.changeEmitter.fire();
    }
    if (intent === 'passive' && this.resolvedCatalogConnectionKey === connectionKey) return;
    if (!config.profileName || !config.baseUrl) {
      if (this.refreshNotification?.connectionKey === connectionKey) this.refreshNotification = undefined;
      this.resolvedCatalogConnectionKey = connectionKey;
      if (intent === 'invalidate' || !this.refreshModelsTask) this.requestModelRefresh(connectionKey);
      this.setConnectionStatus({ phase: 'unconfigured', modelCount: 0 });
      if (this.refreshModelsTask) return this.refreshModelsTask;
      return;
    }
    if (this.refreshModelsTask) {
      if (shouldInvalidateModelRefresh(intent, this.refreshTaskConnectionKey, connectionKey)) {
        this.requestModelRefresh(connectionKey);
      }
      this.updateRefreshNotification(connectionKey, notifySuccess);
      return this.refreshModelsTask;
    }

    this.requestModelRefresh(connectionKey);
    this.updateRefreshNotification(connectionKey, notifySuccess);
    this.refreshModelsTask = this.refreshModelsUntilCurrent()
      .finally(() => {
        this.refreshModelsTask = undefined;
        this.refreshTaskConnectionKey = undefined;
      });
    return this.refreshModelsTask;
  }

  private requestModelRefresh(connectionKey: string): void {
    this.modelRefreshGeneration++;
    this.refreshTaskConnectionKey = connectionKey;
  }

  private updateRefreshNotification(connectionKey: string, notifySuccess: boolean): void {
    if (notifySuccess) {
      this.refreshNotification = { connectionKey, generation: this.modelRefreshGeneration };
    } else if (this.refreshNotification?.generation !== this.modelRefreshGeneration) {
      this.refreshNotification = undefined;
    }
  }

  private async refreshModelsUntilCurrent(): Promise<void> {
    let generation: number;
    do {
      generation = this.modelRefreshGeneration;
      try {
        await this.refreshModelsInternal(generation);
      } catch (error) {
        if (generation === this.modelRefreshGeneration) {
          const config = getConfig();
          const connectionKey = modelConnectionKey(config);
          if (this.matchesRefreshNotification(connectionKey, generation)) this.refreshNotification = undefined;
          this.setConnectionStatus({
            ...connectionStatusFor(config),
            phase: 'error',
            modelCount: 0,
            modelRefreshedAt: Date.now(),
            message: connectionErrorMessage(error),
          });
          throw error;
        }
      }
    } while (generation !== this.modelRefreshGeneration);
  }

  private async refreshModelsInternal(generation: number): Promise<void> {
    const config = getConfig();
    const connectionKey = modelConnectionKey(config);
    if (!config.baseUrl) {
      if (generation === this.modelRefreshGeneration) {
        this.changeEmitter.fire();
      }
      return;
    }

    if (!await this.auth.hasApiKey(config.profileName)) {
      if (this.isCurrentRefresh(generation, connectionKey)) {
        if (this.matchesRefreshNotification(connectionKey, generation)) this.refreshNotification = undefined;
        this.resolvedCatalogConnectionKey = connectionKey;
        this.setConnectionStatus({ ...connectionStatusFor(config), phase: 'keyMissing', modelCount: 0 });
      }
      return;
    }
    if (!this.isCurrentRefresh(generation, connectionKey)) {
      return;
    }
    this.setConnectionStatus({ ...connectionStatusFor(config), phase: 'refreshing', modelCount: this.cachedModels.length });

    const previousSnapshots = new Map(this.routeModelSnapshots);
    const result = await loadAllModels(
      config,
      (profileName) => this.auth.getApiKey(profileName),
      this.debug.bind(this),
      previousSnapshots,
    );
    if (!this.isCurrentRefresh(generation, connectionKey)) {
      return;
    }

    this.cachedModels = result.models;
    this.resolvedCatalogConnectionKey = connectionKey;
    this.routeModelSnapshots.clear();
    for (const [route, snapshot] of result.snapshots) this.routeModelSnapshots.set(route, snapshot);
    this.cacheConnectionKey = connectionKey;
    for (const failure of result.failedRoutes) this.reportRouteRefreshFailure(config, failure.route, failure.error);
    this.setConnectionStatus({
      ...connectionStatusFor(config),
      phase: result.partial ? 'degraded' : 'ready',
      modelCount: result.models.length,
      modelRefreshedAt: Date.now(),
      message: result.partial ? 'Some Relay model routes could not be refreshed.' : undefined,
    });
    this.changeEmitter.fire();
    if (this.matchesRefreshNotification(connectionKey, generation)) {
      this.refreshNotification = undefined;
      void vscode.window.showInformationMessage(`WeaveNet loaded ${this.cachedModels.length} model(s).`);
    }
  }

  private matchesRefreshNotification(connectionKey: string, generation: number): boolean {
    return this.refreshNotification?.connectionKey === connectionKey &&
      this.refreshNotification.generation === generation;
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
    const config = getConfig();
    const connectionKey = modelConnectionKey(config);
    const hasApiKey = await this.auth.hasApiKey(config.profileName);
    const models = this.cacheConnectionKey === connectionKey ? this.cachedModels : [];
    return models.map((model) => toChatInformation(model, config, hasApiKey));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = getConfig();
    if (!config.baseUrl) {
      throw new Error('No WeaveNet Relay connection is configured.');
    }
    if (this.cacheConnectionKey !== modelConnectionKey(config)) {
      throw new Error('The active Relay connection changed. Refresh models and select a model again.');
    }

    const routedModel = this.cachedModels.find((entry) => entry.pickerId === model.id);
    if (!routedModel) {
      throw new vscode.LanguageModelError(`Unknown WeaveNet model route: ${model.id}`);
    }
    const apiKey = await this.auth.getApiKey(config.profileName);
    if (!apiKey) {
      throw new Error('WeaveNet Relay API key is not configured. Run WeaveNet: Set Relay API Key.');
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

  private isCurrentRefresh(generation: number, connectionKey: string): boolean {
    return generation === this.modelRefreshGeneration && modelConnectionKey(getConfig()) === connectionKey;
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    const merged = status.lastDiagnostics === undefined && status.connectionName === this.connectionStatus.connectionName
      ? { ...status, lastDiagnostics: this.connectionStatus.lastDiagnostics }
      : status;
    this.connectionStatus = merged;
    this.connectionStatusEmitter.fire(merged);
  }

  private setTestConnectionStatus(fingerprint: string, status: ConnectionStatus): void {
    if (currentActiveProfileFingerprint() === fingerprint) this.setConnectionStatus(status);
  }

  private restoreActiveDiagnostics(): void {
    const { activeProfile, profiles } = getProfileConfiguration();
    const profile = profiles.find((entry) => entry.name === activeProfile);
    if (!profile) return;
    const diagnostics = this.diagnosticsStore.get(profile, diagnosticsOptions());
    if (diagnostics) {
      this.connectionStatus = {
        ...this.connectionStatus,
        connectionName: profile.name,
        host: safeHost(profile.baseUrl),
        lastDiagnostics: diagnostics,
      };
    }
  }

  private async invalidateDiagnosticsForSecret(secretKey: string): Promise<void> {
    const profileName = profileNameFromSecretKey(secretKey);
    if (profileName) await this.diagnosticsStore.deleteProfile(profileName);
    else await this.diagnosticsStore.clear();
    if (!profileName || this.connectionStatus.connectionName === profileName) {
      this.connectionStatus = { ...this.connectionStatus, lastDiagnostics: undefined };
      this.connectionStatusEmitter.fire(this.connectionStatus);
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
}

function connectionStatusFor(config: ReturnType<typeof getConfig>): Pick<ConnectionStatus, 'connectionName' | 'host'> {
  return { connectionName: config.profileName, host: safeHost(config.baseUrl) };
}

function modelConnectionKey(config: ReturnType<typeof getConfig>): string {
  return JSON.stringify({
    profileName: config.profileName,
    baseUrl: config.baseUrl,
    requestHeaders: config.requestHeaders,
    includeModels: config.includeModels.map((entry) => entry.source),
    excludeModels: config.excludeModels.map((entry) => entry.source),
    models: config.models,
  });
}

function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('claude-');
}

function diagnosticsOptions(): { anthropicVersion: string } {
  return { anthropicVersion: getConfig().anthropicVersion };
}

function currentActiveProfileFingerprint(): string | undefined {
  const { activeProfile, profiles } = getProfileConfiguration();
  const profile = profiles.find((entry) => entry.name === activeProfile);
  return profile ? fingerprintConnection(profile, diagnosticsOptions()) : undefined;
}

function currentProfileFingerprint(profileName: string): string | undefined {
  const profile = getProfileConfiguration().profiles.find((entry) => entry.name === profileName);
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

function profileNameFromSecretKey(key: string): string | undefined {
  const prefix = `${RELAY_API_KEY_SECRET}.profile.`;
  if (!key.startsWith(prefix)) return undefined;
  try { return decodeURIComponent(key.slice(prefix.length)); }
  catch { return undefined; }
}

function isWeaveNetSecretKey(key: string): boolean {
  return key === RELAY_API_KEY_SECRET || key.startsWith(`${RELAY_API_KEY_SECRET}.profile.`) || key === LEGACY_API_KEY_SECRET || [
    OPENAI_API_KEY_SECRET,
    CHATGPT_API_KEY_SECRET,
    CLAUDE_API_KEY_SECRET,
  ].some((secretKey) => key === secretKey);
}

// Protocol request handling lives in openaiResponse.ts and claudeResponse.ts.
