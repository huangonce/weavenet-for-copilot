import * as vscode from 'vscode';
import { AuthManager } from '../auth/auth';
import { getConfig, getProfileConfiguration } from '../config/config';
import type { ConnectionProfile } from '../config/config';
import { CONFIG_SECTION, VENDOR } from '../constants';
import { safeHost } from './connection';
import { supportsImageInputForRoutedModel, toChatInformation } from '../relay/models';
import { provideClaudeResponse } from './claudeResponse';
import {
  ConnectionRuntimeManager,
  isCancellationError,
  isWeaveNetSecretKey,
} from './connectionRuntimeManager';
import type { ConnectionStatus, ModelRefreshIntent } from './connectionRuntimeManager';
import { catalogRevision } from './connectionRuntimeManager';
import { ConnectionDiagnosticsStore } from './connectionDiagnosticsStore';
import { ConnectionTestService } from './connectionTestService';
import type { ConnectionTestResult } from './connectionTestService';
import { estimateTextTokens } from './helpers';
import type { ModelOptions } from './helpers';
import { ModelBindingRegistry } from './modelBindingRegistry';
import { ModelCatalogService } from './modelCatalogService';
import { ModelSnapshotStore } from './modelSnapshotStore';
import { provideOpenAIResponse, provideResponsesResponse } from './openaiResponse';
import { formatLogError } from './requestDiagnostics';
import { resolveOpenAIApiVariant } from '../relay/models';
import { snapshotChatRequest, snapshotChatResponseOptions } from './canonicalRequest';
import {
  resolveVisionProxyMessages,
  selectVisionDescriber,
  validateVisionImageRequest,
  VisionDescriptionCache,
} from './visionProxy';
import type { VisionDescriptionCacheWrite } from './visionProxy';

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
export type { ConnectionStatus, ConnectionStatusEntry } from './connectionRuntimeManager';
export type { ConnectionTestResult } from './connectionTestService';

export class WeaveNetChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly connectionStatusEmitter = new vscode.EventEmitter<ConnectionStatus>();
  private readonly output = vscode.window.createOutputChannel('WeaveNet');
  private readonly auth: AuthManager;
  private readonly diagnosticsStore: ConnectionDiagnosticsStore;
  private readonly modelCatalog: ModelCatalogService;
  private readonly runtimeManager: ConnectionRuntimeManager;
  private readonly bindingRegistry = new ModelBindingRegistry();
  private readonly connectionTest: ConnectionTestService;
  private readonly visionDescriptionCache = new VisionDescriptionCache();
  private visionCacheGeneration = 0;
  private connectionStatus: ConnectionStatus = {
    phase: 'unconfigured', connectionCount: 0, modelCount: 0, warningCount: 0, refreshingCount: 0, connections: [],
  };

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  readonly onDidChangeConnectionStatus = this.connectionStatusEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets);
    this.diagnosticsStore = new ConnectionDiagnosticsStore(context.globalState);
    this.modelCatalog = new ModelCatalogService(new ModelSnapshotStore(context.globalState), this.debug.bind(this));
    this.runtimeManager = new ConnectionRuntimeManager({
      auth: this.auth,
      diagnosticsStore: this.diagnosticsStore,
      catalog: this.modelCatalog,
      debug: this.debug.bind(this),
      rebuildBindings: () => {
        this.bindingRegistry.rebuild(this.runtimeManager.getRuntimes());
      },
      onStatusChanged: (status) => {
        this.connectionStatus = status;
        this.connectionStatusEmitter.fire(status);
      },
      onCatalogChanged: () => {
        this.invalidateVisionRouting();
        this.changeEmitter.fire();
      },
    });
    this.connectionTest = new ConnectionTestService({
      auth: this.auth,
      diagnosticsStore: this.diagnosticsStore,
      onTestStatus: (profileId, fingerprint, status) => this.runtimeManager.setTestConnectionStatus(profileId, fingerprint, status),
    });
    this.runtimeManager.syncProfiles();
    context.subscriptions.push(
      this.changeEmitter,
      this.connectionStatusEmitter,
      this.output,
      vscode.lm.onDidChangeChatModels(() => {
        this.invalidateVisionRouting();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          if (
            event.affectsConfiguration(`${CONFIG_SECTION}.visionProxyEnabled`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.visionProxyModel`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.visionProxyPrompt`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.supportsImageInput`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.imageInputModels`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.disabledImageInputModels`)
            || event.affectsConfiguration(`${CONFIG_SECTION}.profiles`)
          ) {
            this.invalidateVisionRouting();
          }
          void this.runtimeManager.reconcileConfiguration();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (isWeaveNetSecretKey(event.key)) {
          void this.runtimeManager.handleSecretChange(event.key);
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
    await this.connectionTest.clearDiagnostics(profile);
  }

  async clearAllConnectionDiagnostics(): Promise<void> {
    await this.connectionTest.clearAllDiagnostics();
  }

  testConnection(profile: ConnectionProfile): Promise<ConnectionTestResult> {
    return this.connectionTest.test(profile);
  }

  async refreshModels(intent: ModelRefreshIntent = 'passive', notifySuccess = false, token?: vscode.CancellationToken, forceProbe = false): Promise<void> {
    await this.runtimeManager.refreshAll(intent === 'invalidate', token, forceProbe);
    if (notifySuccess) this.showRefreshSummary();
  }

  async refreshConnection(profileId: string, force = true): Promise<void> {
    await this.runtimeManager.refreshConnection(profileId, force);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      await this.refreshModels('passive', options.silent === false, token);
    } catch (error) {
      if (!isCancellationError(error)) {
        this.debug(getConfig(), `[models] model picker refresh failed: ${formatLogError(error)}`);
      }
    }
    const entries = this.bindingRegistry.all();
    const keyStates = new Map<string, boolean>();
    await Promise.all([...new Set(entries.map(({ profileId }) => profileId))].map(async (profileId) => {
      const runtime = this.runtimeManager.getRuntime(profileId);
      if (!runtime) return;
      try {
        keyStates.set(profileId, await this.auth.hasApiKey(runtime.profile));
      } catch (error) {
        keyStates.set(profileId, false);
        this.debug(getConfig(runtime.profile), `[models] connection=${runtime.profile.name}, API key status read failed: ${formatLogError(error)}`);
      }
    }));
    return entries.flatMap(({ profileId, model }) => {
      const runtime = this.runtimeManager.getRuntime(profileId);
      if (!runtime) return [];
      const hasApiKey = keyStates.get(profileId) === true;
      const info = toChatInformation(model, getConfig(runtime.profile), hasApiKey, {
        name: runtime.profile.name,
        host: safeHost(runtime.profile.baseUrl),
      });
      return [hasApiKey ? info : { ...info, statusIcon: new vscode.ThemeIcon('warning') }];
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const messageSnapshot = snapshotChatRequest(messages);
    const optionsSnapshot = snapshotChatResponseOptions(options);
    if (messageSnapshot.hasImages) validateVisionImageRequest(messageSnapshot);
    const binding = this.bindingRegistry.get(model.id);
    if (!binding) {
      throw new vscode.LanguageModelError(`Unknown WeaveNet model route: ${model.id}`);
    }
    const runtime = this.runtimeManager.getRuntime(binding.profileId);
    if (!runtime || runtime.revision !== binding.revision) {
      throw vscode.LanguageModelError.NotFound('This model connection changed. Refresh models and select it again.');
    }
    const currentProfile = getProfileConfiguration().profiles.find((profile) => profile.id === binding.profileId);
    if (!currentProfile || catalogRevision(currentProfile) !== binding.revision) {
      throw vscode.LanguageModelError.NotFound('This model connection is no longer available. Refresh models and select it again.');
    }
    const config = getConfig(currentProfile);
    const visionCacheGeneration = this.visionCacheGeneration;
    const routedModel = binding.model;
    const apiKey = await this.auth.getApiKey(currentProfile);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(`The API key for “${currentProfile.name}” is not configured.`);
    }
    this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
    const nativeImageInput = supportsImageInputForRoutedModel(routedModel, config);
    let resolvedMessages = messageSnapshot;
    let pendingVisionCacheWrites: readonly VisionDescriptionCacheWrite[] = [];
    try {
      if (!nativeImageInput && messageSnapshot.hasImages) {
        if (!config.visionProxyEnabled) {
          throw new vscode.LanguageModelError(
            'This WeaveNet model does not support native image input. Enable the WeaveNet vision proxy and select an installed native vision model, or choose a native vision model directly.',
          );
        }
        const vision = await resolveVisionProxyMessages(
          messageSnapshot,
          config,
          { vendor: VENDOR, id: model.id },
          token,
          this.visionDescriptionCache,
          async (configuredModel, targetModel) => {
            const selected = await selectVisionDescriber(
              configuredModel,
              targetModel,
              (candidate) => this.isSafeVisionProxyCandidate(candidate),
            );
            this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
            return selected;
          },
        );
        resolvedMessages = vision.messages;
        pendingVisionCacheWrites = vision.pendingCacheWrites;
        this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
        this.debug(
          config,
          `[vision-proxy] generated=${vision.generatedImageMessages}, replayed=${vision.replayedImageMessages}, `
            + `model=${vision.visionModel ? `${vision.visionModel.vendor}/${vision.visionModel.id}` : 'none'}`,
        );
      }
      const context = {
        config,
        routedModel,
        model,
        messages: resolvedMessages,
        options: optionsSnapshot,
        progress,
        token,
        apiKey,
        debug: this.debug.bind(this),
      };
      this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
      if (routedModel.protocol === 'claude') await provideClaudeResponse(context);
      else if (resolveOpenAIApiVariant(routedModel) === 'responses') await provideResponsesResponse(context);
      else await provideOpenAIResponse(context);
      if (!token.isCancellationRequested && visionCacheGeneration === this.visionCacheGeneration) {
        this.visionDescriptionCache.commitAll(pendingVisionCacheWrites);
      } else {
        this.visionDescriptionCache.releasePending(pendingVisionCacheWrites);
      }
    } catch (error) {
      this.visionDescriptionCache.releasePending(pendingVisionCacheWrites);
      throw error;
    }
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

  private assertVisionConfigurationCurrent(
    generation: number,
    hasImages: boolean,
  ): void {
    if (hasImages && generation !== this.visionCacheGeneration) {
      throw new vscode.CancellationError();
    }
  }

  private invalidateVisionRouting(): void {
    this.visionDescriptionCache.clear();
    this.visionCacheGeneration += 1;
  }

  isSafeVisionProxyCandidate(candidate: vscode.LanguageModelChat): boolean {
    if (candidate.vendor !== VENDOR) return true;
    const binding = this.bindingRegistry.get(candidate.id);
    if (!binding) return false;
    const runtime = this.runtimeManager.getRuntime(binding.profileId);
    if (!runtime) return false;
    return supportsImageInputForRoutedModel(binding.model, getConfig(runtime.profile));
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

  private showRefreshSummary(): void {
    const total = this.connectionStatus.connectionCount;
    const warnings = this.connectionStatus.warningCount;
    const healthy = total - warnings;
    void vscode.window.showInformationMessage(
      `WeaveNet loaded ${this.connectionStatus.modelCount} model(s) from ${healthy}/${total} connection(s)${warnings ? `; ${warnings} warning(s)` : ''}.`,
    );
  }
}
