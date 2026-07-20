import * as vscode from 'vscode';
import { AuthManager } from '../auth/auth';
import { getConfig } from '../config/config';
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
import type { RoutedModel } from '../relay/types';
import {
  ConnectionTestError,
  connectionErrorMessage,
  describeConnectionTestError,
  safeEndpoint,
  safeHost,
  shouldApplyTestConnectionStatus,
} from './connection';
import type { ConnectionTestFailure } from './connection';
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
  checkedAt?: number;
  message?: string;
}

export interface ConnectionTestResult {
  connectionName: string;
  host: string;
  modelCount: number;
  elapsedMs: number;
  endpoint: string;
  models: RelayEndpointTestResult;
  claudeMessages?: RelayEndpointTestResult;
  claudeMessagesError?: ConnectionTestFailure;
}

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

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  readonly onDidChangeConnectionStatus = this.connectionStatusEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets);
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

  async testConnection(profileName: string, baseUrl: string, requestHeaders: Record<string, string> = {}): Promise<ConnectionTestResult> {
    const host = safeHost(baseUrl) ?? 'unknown host';
    const endpoint = safeEndpoint(baseUrl, '/models');
    if (!safeHost(baseUrl)) {
      throw new ConnectionTestError({ category: 'url', message: 'The Relay Base URL must be a valid http(s) URL.' });
    }
    const apiKey = await this.auth.getApiKey(profileName);
    if (!apiKey) {
      this.setTestConnectionStatus(profileName, { connectionName: profileName, host, phase: 'keyMissing', modelCount: 0 });
      throw new ConnectionTestError({ category: 'authentication', message: 'API key is required for this connection.' });
    }
    const startedAt = Date.now();
    try {
      const client = new RelayClient({
        baseUrl,
        apiKey,
        requestHeaders,
        requestTimeoutMs: getConfig().requestTimeoutMs,
        streamIdleTimeoutMs: getConfig().streamIdleTimeoutMs,
      });
      const { models, diagnostic } = await client.testModels();
      const modelCount = Array.isArray(models.data) ? models.data.length : 0;
      const claudeModel = models.data?.find((model) => isClaudeModel(model.id));
      let claudeMessages: RelayEndpointTestResult | undefined;
      let claudeMessagesError: ConnectionTestFailure | undefined;
      if (claudeModel) {
        try {
          claudeMessages = await client.testClaudeMessages(claudeModel.id);
        } catch (error) {
          claudeMessagesError = describeConnectionTestError(error);
        }
      }
      const result = { connectionName: profileName, host, modelCount, elapsedMs: Date.now() - startedAt, endpoint, models: diagnostic, claudeMessages, claudeMessagesError };
      this.setTestConnectionStatus(profileName, { connectionName: profileName, host, phase: 'ready', modelCount, checkedAt: Date.now() });
      return result;
    } catch (error) {
      const failure = describeConnectionTestError(error);
      this.setTestConnectionStatus(profileName, { connectionName: profileName, host, phase: 'error', modelCount: 0, checkedAt: Date.now(), message: failure.message });
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
            checkedAt: Date.now(),
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
      checkedAt: Date.now(),
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
    this.connectionStatus = status;
    this.connectionStatusEmitter.fire(status);
  }

  private setTestConnectionStatus(profileName: string, status: ConnectionStatus): void {
    if (shouldApplyTestConnectionStatus(getConfig().profileName, profileName)) this.setConnectionStatus(status);
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

function isWeaveNetSecretKey(key: string): boolean {
  return key === RELAY_API_KEY_SECRET || key.startsWith(`${RELAY_API_KEY_SECRET}.profile.`) || key === LEGACY_API_KEY_SECRET || [
    OPENAI_API_KEY_SECRET,
    CHATGPT_API_KEY_SECRET,
    CLAUDE_API_KEY_SECRET,
  ].some((secretKey) => key === secretKey);
}

// Protocol request handling lives in openaiResponse.ts and claudeResponse.ts.
