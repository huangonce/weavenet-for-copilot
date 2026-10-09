import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { catalogArtifactRevision } from './catalogIdentity';
import { AuthManager } from '../auth/auth';
import { getConfig, getProfileConfiguration } from '../config/config';
import type { ApiType, ConnectionProfile } from '../config/config';
import { CONFIG_SECTION, VENDOR } from '../constants';
import { t } from '../l10n';
import { safeHost, sanitizeLanguageModelError } from './connection';
import { supportsImageInputForRoutedModel, supportsToolCallingForModel, toChatInformation } from '../relay/models';
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
import type { ProtocolReplayState } from '../relay/replayState';
import type { RoutedModel } from '../relay/types';
import { formatLogError } from './requestDiagnostics';
import { snapshotChatRequest, snapshotChatResponseOptions } from './canonicalRequest';
import { IMAGE_ONLY_TOOL_RESULT_TEXT, normalizeToolResultBatches } from './toolResultImageNormalization';
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
  sanitizeLanguageModelError,
  toLanguageModelError,
} from './connection';
export type { ConnectionTestFailure } from './connection';
export {
  estimateTextTokens,
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

  async refreshModels(intent: ModelRefreshIntent = 'passive', notifySuccess = false, token?: vscode.CancellationToken): Promise<void> {
    await this.runtimeManager.refreshAll(intent === 'invalidate', token);
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
      // A cancelled enumeration must not resolve with a stale catalog, and the
      // host-owned picker path never shows a refresh toast of its own.
      await this.refreshModels('passive', false, token);
    } catch (error) {
      if (isCancellationError(error)) throw new vscode.CancellationError();
      this.debug(getConfig(), `[models] model picker refresh failed: ${formatLogError(error)}`);
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
    try {
      await this.provideLanguageModelChatResponseInner(model, messages, options, progress, token);
    } catch (error) {
      // Errors cross the extension-host RPC boundary before Chat renders them.
      // Sanitize here so the user only ever sees the clean message text, never
      // the internal extension-host stack (`at i.tryDeserialize (...)` frames).
      throw sanitizeLanguageModelError(error);
    }
  }

  private async provideLanguageModelChatResponseInner(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const messageSnapshot = snapshotChatRequest(messages);
    const optionsSnapshot = snapshotChatResponseOptions(options);
    const binding = this.bindingRegistry.get(model.id);
    if (!binding) {
      throw new vscode.LanguageModelError(t('Unknown WeaveNet model route: {0}', model.id));
    }
    const runtime = this.runtimeManager.getRuntime(binding.profileId);
    if (!runtime || runtime.revision !== binding.revision) {
      throw vscode.LanguageModelError.NotFound(t('This model connection changed. Refresh models and select it again.'));
    }
    const currentProfile = getProfileConfiguration().profiles.find((profile) => profile.id === binding.profileId);
    if (!currentProfile || catalogRevision(currentProfile) !== binding.revision) {
      throw vscode.LanguageModelError.NotFound(t('This model connection is no longer available. Refresh models and select it again.'));
    }
    const config = getConfig(currentProfile);
    const visionCacheGeneration = this.visionCacheGeneration;
    const routedModel = binding.model;
    if (optionsSnapshot.toolMode === vscode.LanguageModelChatToolMode.Required
      && (!optionsSnapshot.tools?.length || !supportsToolCallingForModel(routedModel, config))) {
      throw new vscode.LanguageModelError(t('Required tool mode needs a tool-capable model and at least one available tool.'));
    }
    const apiKey = await this.auth.getApiKey(currentProfile);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(t('The API key for “{0}” is not configured.', currentProfile.name));
    }
    this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
    const nativeImageInput = supportsImageInputForRoutedModel(routedModel, config);
    let resolvedMessages = messageSnapshot;
    let pendingVisionCacheWrites: readonly VisionDescriptionCacheWrite[] = [];
    try {
      if (nativeImageInput && messageSnapshot.hasImages) {
        validateVisionImageRequest(messageSnapshot);
      } else if (messageSnapshot.hasImages) {
        if (!config.visionProxyEnabled) {
          throw new vscode.LanguageModelError(t('This WeaveNet model does not support native image input. Enable the WeaveNet vision proxy and select an installed native vision model, or choose a native vision model directly.'));
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
      resolvedMessages = normalizeToolResultBatches(resolvedMessages);
      const artifactIdentity = catalogArtifactRevision(config, apiKey, await this.auth.getCatalogArtifactPepper());
      const protocolIdentity = createHash('sha256').update(JSON.stringify({ artifactIdentity,
        model: routedModel.upstreamId, apiType: routedModel.apiType })).digest('hex');
      const context = {
        config,
        routedModel,
        model,
        messages: resolvedMessages,
        options: optionsSnapshot,
        progress,
        token,
        apiKey,
        protocolIdentity,
        debug: this.debug.bind(this),
      };
      this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
      if (routedModel.apiType === 'messages') await provideClaudeResponse(context);
      else if (routedModel.apiType === 'responses') await provideResponsesResponse(context);
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
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') return estimateTextTokens(text);
    if (_token.isCancellationRequested) throw new vscode.CancellationError();
    const canonical = snapshotChatRequest([text]).messages[0];
    const countImage = (bytes: number) => Math.max(256, Math.ceil(bytes / 768));
    let tokens = 4;
    for (const part of canonical.content) {
      if (_token.isCancellationRequested) throw new vscode.CancellationError();
      if (part.kind === 'text') tokens += estimateTextTokens(part.value);
      else if (part.kind === 'toolCall') tokens += estimateTextTokens(part.name) + estimateTextTokens(part.inputJson);
      else if (part.kind === 'toolResult') {
        let hasText = false;
        let hasImage = false;
        for (const nested of part.content) {
          if (nested.kind === 'text') { tokens += estimateTextTokens(nested.value); hasText ||= !!nested.value.trim(); }
          else { tokens += countImage(nested.byteLength); hasImage = true; }
        }
        if (hasImage && !hasText) tokens += estimateTextTokens(IMAGE_ONLY_TOOL_RESULT_TEXT);
      } else if (part.kind === 'data') tokens += countImage(part.byteLength);
    }
    const boundModel = this.bindingRegistry.get(model.id)?.model;
    // Replayed reasoning is resent on the next turn, so it must be counted for
    // every protocol that actually replays it: Messages always, and Chat
    // Completions / Responses only with an explicit replay capability.
    const reasoningReplay = replayProtocolFor(boundModel);
    if (reasoningReplay) {
      const states = canonical.content.flatMap(part => part.kind === 'thinking' && part.protocolReplay?.apiType === reasoningReplay ? [part.protocolReplay] : []);
      const reasoning = states.length
        ? states.flatMap(replayedReasoningText)
        : canonical.content.flatMap(part => part.kind === 'thinking' ? [part.value] : []);
      for (const value of reasoning) if (value) tokens += estimateTextTokens(value);
    }
    return tokens;
  }

  private showRefreshSummary(): void {
    const total = this.connectionStatus.connectionCount;
    const warnings = this.connectionStatus.warningCount;
    const healthy = total - warnings;
    void vscode.window.showInformationMessage(
      t('WeaveNet loaded {0} model(s) from {1}/{2} connection(s){3}.', this.connectionStatus.modelCount, healthy, total,
        warnings ? t('; {0} warning(s)', warnings) : ''),
    );
  }
}

/** Protocol whose replayed reasoning is resent for this model, if any. */
function replayProtocolFor(model: RoutedModel | undefined): ApiType | undefined {
  if (!model) return undefined;
  if (model.apiType === 'messages') return 'messages';
  return model.openai?.replayReasoningContent === true ? model.apiType : undefined;
}

function replayedReasoningText(state: ProtocolReplayState): string[] {
  if (state.apiType === 'chat-completions') return [state.chat?.reasoning_content ?? ''];
  if (state.apiType === 'messages') return (state.claude ?? []).flatMap((block) => block.type === 'thinking' ? [block.thinking] : []);
  return (state.responses ?? []).flatMap((item) => item.type === 'reasoning'
    ? (item.content ?? []).flatMap((content) => content.type === 'reasoning_text' ? [content.text] : [])
    : []);
}
