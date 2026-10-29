import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { catalogArtifactRevision } from './catalogIdentity';
import { AuthManager } from '../auth/auth';
import { RelayClient } from '../relay/client';
import { canonicalRelayHeaders } from '../relay/headers';
import { stableJsonValue } from '../json';
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
  waitForRefresh,
} from './connectionRuntimeManager';
import type { ConnectionStatus, ModelRefreshIntent } from './connectionRuntimeManager';
import { catalogRevision } from './connectionRuntimeManager';
import { ConnectionDiagnosticsStore } from './connectionDiagnosticsStore';
import { ConnectionTestService } from './connectionTestService';
import type { ConnectionTestResult } from './connectionTestService';
import { estimateTextTokens } from './helpers';
import type { ModelOptions } from './helpers';
import { ModelBindingRegistry } from './modelBindingRegistry';
import type { BoundModel } from './modelBindingRegistry';
import { ModelCatalogService } from './modelCatalogService';
import { ModelSnapshotStore } from './modelSnapshotStore';
import { provideOpenAIResponse, provideResponsesResponse } from './openaiResponse';
import type { ProtocolReplayState } from '../relay/replayState';
import type { RoutedModel } from '../relay/types';
import { formatLogError } from './requestDiagnostics';
import { snapshotChatRequest, snapshotChatResponseOptions } from './canonicalRequest';
import type { CanonicalChatMessage } from './canonicalRequest';
import { convertResponsesInput } from './convert';
import { IMAGE_ONLY_TOOL_RESULT_TEXT, normalizeToolResultBatches } from './toolResultImageNormalization';
import {
  resolveVisionProxyMessages,
  selectVisionDescriber,
  validateVisionImageRequest,
  VisionDescriptionCache,
} from './visionProxy';
import type { VisionDescriptionCacheWrite } from './visionProxy';
import { estimateCanonicalTextTokens, reservedVisionDescriptionTokens } from './visionBudget';
import { collectVisionReplayEntries, createVisionReplayPart } from './visionReplay';

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
  private modelInformationSignature = '';
  private visionRoutingSignature = '';
  private externalVisionModel?: { key: string; signature: string };
  private externalVisionRefresh?: Promise<void>;
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
        this.publishModelCatalog();
      },
      onConnectionInvalidated: profileId => this.connectionTest.invalidate(profileId),
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
        this.refreshExternalVisionModel();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION)) return;
        const affects = (setting: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${setting}`);
        const visionChanged = [
          'visionProxyEnabled', 'visionProxyModel', 'visionProxyPrompt',
          'supportsImageInput', 'imageInputModels', 'disabledImageInputModels',
        ].some(affects);
        if (visionChanged) this.invalidateVisionRouting();
        if (affects('profiles') || affects('modelMetadataEnabled')) {
          void this.runtimeManager.reconcileConfiguration();
        } else if (visionChanged || ['modelNamePrefix', 'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling'].some(affects)) {
          this.publishModelCatalog();
        }
        // Request-only settings are read when the next request is constructed.
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

  refreshModelMetadata(): void {
    this.runtimeManager.refreshModelMetadata();
  }

  async getTokenCountingModels(token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    const models = await this.provideLanguageModelChatInformation({ silent: false }, token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return models.filter(model => {
      const routed = this.bindingRegistry.get(model.id)?.model;
      return routed?.apiType === 'responses' && routed.openai?.tokenCounting === true;
    });
  }

  async compareInputTokenCount(modelId: string, text: string, token: vscode.CancellationToken): Promise<{ localEstimate: number; serverCount: number }> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const binding = this.bindingRegistry.get(modelId);
    if (!binding) throw new vscode.LanguageModelError(t('Unknown WeaveNet model route: {0}', modelId));
    if (binding.model.apiType !== 'responses' || binding.model.openai?.tokenCounting !== true) {
      throw new vscode.LanguageModelError(t('This model does not declare Responses input token counting support.'));
    }
    const credential = this.runtimeManager.getRuntime(binding.profileId)?.credentialRevision;
    const assertCurrent = () => {
      const profile = this.assertModelConnectionCurrent(binding, credential, token);
      const current = this.bindingRegistry.get(modelId);
      if (current?.model.openai?.tokenCounting !== true) {
        throw vscode.LanguageModelError.NotFound(t('This model connection changed. Refresh models and select it again.'));
      }
      return profile;
    };
    const profile = assertCurrent();
    const config = getConfig(profile);
    const message: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(text)], name: undefined,
    };
    const snapshot = snapshotChatRequest([message]);
    const { input, instructions } = convertResponsesInput(snapshot, false);
    const localEstimate = await this.provideTokenCount(toChatInformation(binding.model, config, true), message, token);
    const apiKey = await this.auth.getApiKey(profile);
    assertCurrent();
    if (!apiKey) throw vscode.LanguageModelError.NoPermissions(t('The API key for “{0}” is not configured.', profile.name));
    const client = new RelayClient({ baseUrl: config.baseUrl, apiKey, requestHeaders: config.requestHeaders,
      requestTimeoutMs: config.requestTimeoutMs, streamIdleTimeoutMs: config.streamIdleTimeoutMs });
    const serverCount = await client.countResponsesInputTokens({ model: binding.model.upstreamId, input, ...(instructions ? { instructions } : {}) }, token);
    assertCurrent();
    return { localEstimate, serverCount };
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      await this.runtimeManager.prepareCatalog(options.silent, token);
    } catch (error) {
      if (isCancellationError(error)) throw new vscode.CancellationError();
      this.debug(getConfig(), `[models] model picker refresh failed: ${formatLogError(error)}`);
    }
    const entries = this.bindingRegistry.all();
    const keyStates = new Map<string, { hasApiKey: boolean; revision: string; credentialRevision?: string }>();
    await waitForRefresh(Promise.all([...new Set(entries.map(({ profileId }) => profileId))].map(async (profileId) => {
      const runtime = this.runtimeManager.getRuntime(profileId);
      if (!runtime) return;
      const { revision, credentialRevision } = runtime;
      try {
        keyStates.set(profileId, { hasApiKey: await this.auth.hasApiKey(runtime.profile), revision, credentialRevision });
      } catch (error) {
        keyStates.set(profileId, { hasApiKey: false, revision, credentialRevision });
        this.debug(getConfig(runtime.profile), `[models] connection=${runtime.profile.name}, API key status read failed: ${formatLogError(error)}`);
      }
    })).then(() => undefined), token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const profiles = new Map(getProfileConfiguration().profiles.map(profile => [profile.id, profile]));
    const contexts = new Map<string, {
      config: ReturnType<typeof getConfig>;
      source: { name: string; host: string | undefined };
      hasApiKey: boolean;
    }>();
    for (const [profileId, { hasApiKey, revision, credentialRevision }] of keyStates) {
      const runtime = this.runtimeManager.getRuntime(profileId);
      const profile = profiles.get(profileId);
      if (!runtime || !profile || runtime.revision !== revision || catalogRevision(profile) !== revision
        || runtime.credentialRevision !== credentialRevision) continue;
      contexts.set(profileId, {
        config: getConfig(profile),
        source: { name: profile.name, host: safeHost(profile.baseUrl) },
        hasApiKey,
      });
    }
    return entries.flatMap(({ profileId, revision, model }) => {
      const context = contexts.get(profileId);
      const binding = this.bindingRegistry.get(model.pickerId);
      if (!context || !binding || binding.revision !== revision) return [];
      const { config, source, hasApiKey } = context;
      const info = toChatInformation(binding.model, config, hasApiKey, source);
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
    const credential = this.runtimeManager.getRuntime(binding.profileId)?.credentialRevision;
    const currentProfile = this.assertModelConnectionCurrent(binding, credential, token);
    const config = getConfig(currentProfile);
    const visionCacheGeneration = this.visionCacheGeneration;
    const routedModel = binding.model;
    if (optionsSnapshot.toolMode === vscode.LanguageModelChatToolMode.Required
      && (!optionsSnapshot.tools?.length || !supportsToolCallingForModel(routedModel, config))) {
      throw new vscode.LanguageModelError(t('Required tool mode needs a tool-capable model and at least one available tool.'));
    }
    const apiKey = await this.auth.getApiKey(currentProfile);
    this.assertModelConnectionCurrent(binding, credential, token);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(t('The API key for “{0}” is not configured.', currentProfile.name));
    }
    const artifactIdentity = catalogArtifactRevision(config, apiKey, await this.auth.getCatalogArtifactPepper());
    const protocolIdentity = createHash('sha256').update(JSON.stringify({ artifactIdentity,
      model: routedModel.upstreamId, apiType: routedModel.apiType })).digest('hex');
    this.assertModelConnectionCurrent(binding, credential, token);
    this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
    const nativeImageInput = supportsImageInputForRoutedModel(routedModel, config);
    if (messageSnapshot.hasImages && !nativeImageInput) {
      await this.waitForExternalVisionRefresh(token);
      this.assertVisionConfigurationCurrent(visionCacheGeneration, true);
    }
    let resolvedMessages = messageSnapshot;
    let pendingVisionCacheWrites: readonly VisionDescriptionCacheWrite[] = [];
    let visionReplayPart: vscode.LanguageModelResponsePart | undefined;
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
              (candidate) => {
                if (candidate.vendor !== VENDOR) {
                  const signature = externalVisionSignature(candidate);
                  this.externalVisionModel = signature ? { key: configuredModel, signature } : undefined;
                }
                return this.isSafeVisionProxyCandidate(candidate);
              },
            );
            this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
            return selected;
          },
          {
            maxInputTokens: model.maxInputTokens,
            baseInputTokens: estimateCanonicalTextTokens(normalizeToolResultBatches(messageSnapshot).messages)
              + estimateReplayedReasoningTokens(messageSnapshot.messages, routedModel)
              + (optionsSnapshot.tools?.length ? estimateTextTokens(JSON.stringify(optionsSnapshot.tools)) : 0),
            replayEntries: collectVisionReplayEntries(messageSnapshot, protocolIdentity),
          },
        );
        resolvedMessages = vision.messages;
        pendingVisionCacheWrites = vision.pendingCacheWrites;
        visionReplayPart = createVisionReplayPart(protocolIdentity, vision.replayEntries);
        await this.waitForExternalVisionRefresh(token);
        this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
        this.debug(
          config,
          `[vision-proxy] generated=${vision.generatedImageMessages}, replayed=${vision.replayedImageMessages}, `
            + `model=${vision.visionModel ? `${vision.visionModel.vendor}/${vision.visionModel.id}` : 'none'}`,
        );
      }
      resolvedMessages = normalizeToolResultBatches(resolvedMessages);
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
      this.assertModelConnectionCurrent(binding, credential, token);
      this.assertVisionConfigurationCurrent(visionCacheGeneration, messageSnapshot.hasImages);
      if (routedModel.apiType === 'messages') await provideClaudeResponse(context);
      else if (routedModel.apiType === 'responses') await provideResponsesResponse(context);
      else await provideOpenAIResponse(context);
      if (!token.isCancellationRequested && visionCacheGeneration === this.visionCacheGeneration) {
        if (visionReplayPart) progress.report(visionReplayPart);
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

  private assertModelConnectionCurrent(
    binding: BoundModel,
    credential: string | undefined,
    token: vscode.CancellationToken,
  ): ConnectionProfile {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const current = this.bindingRegistry.get(binding.model.pickerId);
    const runtime = this.runtimeManager.getRuntime(binding.profileId);
    if (!current || !runtime || runtime.revision !== binding.revision || current.revision !== binding.revision
      || current.model.upstreamId !== binding.model.upstreamId || current.model.apiType !== binding.model.apiType
      || runtime.credentialRevision !== credential) {
      throw vscode.LanguageModelError.NotFound(t('This model connection changed. Refresh models and select it again.'));
    }
    const profile = getProfileConfiguration().profiles.find(candidate => candidate.id === binding.profileId);
    if (!profile || catalogRevision(profile) !== binding.revision) {
      throw vscode.LanguageModelError.NotFound(t('This model connection is no longer available. Refresh models and select it again.'));
    }
    return profile;
  }

  private invalidateVisionRouting(): void {
    this.visionDescriptionCache.clear();
    this.visionCacheGeneration += 1;
    this.externalVisionModel = undefined;
  }

  private publishModelCatalog(): void {
    const information: unknown[] = [];
    const routes: unknown[] = [];
    for (const runtime of this.runtimeManager.getRuntimes()) {
      const config = getConfig(runtime.profile);
      const source = { name: runtime.profile.name, host: safeHost(runtime.profile.baseUrl) };
      const connectionRoute = [runtime.profile.id, runtime.profile.baseUrl, canonicalRelayHeaders(config.requestHeaders), runtime.credentialRevision];
      for (const model of runtime.models) {
        information.push([runtime.profile.id, toChatInformation(model, config, true, source)]);
        routes.push([connectionRoute,
          model.pickerId, model.upstreamId, model.apiType, supportsImageInputForRoutedModel(model, config), model.openai?.imageCompatibility]);
      }
    }
    const informationSignature = createHash('sha256').update(JSON.stringify(stableJsonValue(information))).digest('hex');
    const routingSignature = createHash('sha256').update(JSON.stringify(stableJsonValue(routes))).digest('hex');
    const routingChanged = routingSignature !== this.visionRoutingSignature;
    const informationChanged = informationSignature !== this.modelInformationSignature;
    this.modelInformationSignature = informationSignature;
    this.visionRoutingSignature = routingSignature;
    if (routingChanged) this.invalidateVisionRouting();
    if (informationChanged) this.changeEmitter.fire();
  }

  private refreshExternalVisionModel(): void {
    const config = getConfig();
    if (!config.visionProxyEnabled) return;
    const slash = config.visionProxyModel.indexOf('/');
    if (slash < 1) return;
    const vendor = config.visionProxyModel.slice(0, slash);
    const id = config.visionProxyModel.slice(slash + 1);
    if (vendor === VENDOR) return; // Our catalog changes already validate our own routes.
    const previous = this.externalVisionModel;
    if (!previous || previous.key !== config.visionProxyModel) {
      this.invalidateVisionRouting();
      return;
    }
    const generation = this.visionCacheGeneration;
    const task = Promise.resolve(vscode.lm.selectChatModels({ vendor, id })).then(models => {
      if (this.externalVisionRefresh !== task || generation !== this.visionCacheGeneration) return;
      const matching = models.filter(model => model.vendor === vendor && model.id === id);
      if (matching.length !== 1 || externalVisionSignature(matching[0]) !== previous.signature) this.invalidateVisionRouting();
    }, () => {
      if (this.externalVisionRefresh === task && generation === this.visionCacheGeneration) this.invalidateVisionRouting();
    }).finally(() => {
      if (this.externalVisionRefresh === task) this.externalVisionRefresh = undefined;
    });
    this.externalVisionRefresh = task;
  }

  private async waitForExternalVisionRefresh(token: vscode.CancellationToken): Promise<void> {
    while (this.externalVisionRefresh) await waitForRefresh(this.externalVisionRefresh, token);
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
    if (_token.isCancellationRequested) throw new vscode.CancellationError();
    if (typeof text === 'string') return estimateTextTokens(text);
    const canonical = snapshotChatRequest([text]).messages[0];
    const binding = this.bindingRegistry.get(model.id);
    const runtime = binding ? this.runtimeManager.getRuntime(binding.profileId) : undefined;
    const config = runtime ? getConfig(runtime.profile) : undefined;
    const useVisionProxy = !!binding && !!config && config.visionProxyEnabled
      && !supportsImageInputForRoutedModel(binding.model, config);
    let imageCount = 0;
    const countImage = (bytes: number) => {
      if (!useVisionProxy) return Math.max(256, Math.ceil(bytes / 768));
      imageCount++;
      return 0;
    };
    let tokens = estimateCanonicalTextTokens([canonical]);
    for (const part of canonical.content) {
      if (_token.isCancellationRequested) throw new vscode.CancellationError();
      if (part.kind === 'toolResult') {
        let hasText = false;
        let hasImage = false;
        for (const nested of part.content) {
          if (nested.kind === 'text') hasText ||= !!nested.value.trim();
          else { tokens += countImage(nested.byteLength); hasImage = true; }
        }
        if (hasImage && !hasText && !useVisionProxy) tokens += estimateTextTokens(IMAGE_ONLY_TOOL_RESULT_TEXT);
      } else if (part.kind === 'data') tokens += countImage(part.byteLength);
    }
    return tokens + estimateReplayedReasoningTokens([canonical], binding?.model) + reservedVisionDescriptionTokens(imageCount);
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

function externalVisionSignature(model: vscode.LanguageModelChat): string | undefined {
  const capabilities = (model as vscode.LanguageModelChat & {
    readonly capabilities?: { readonly supportsImageToText?: boolean };
  }).capabilities;
  if (!model.version || !Number.isFinite(model.maxInputTokens) || capabilities?.supportsImageToText !== true) return undefined;
  return JSON.stringify([model.vendor, model.id, model.version, model.family, model.maxInputTokens, capabilities.supportsImageToText]);
}

/** Count reasoning only for protocols that resend it, without counting visible and replay copies twice. */
function estimateReplayedReasoningTokens(messages: readonly CanonicalChatMessage[], boundModel?: RoutedModel): number {
  const reasoningReplay = replayProtocolFor(boundModel);
  if (!reasoningReplay) return 0;
  let tokens = 0;
  for (const message of messages) {
    const states = message.content.flatMap(part => part.kind === 'thinking' && part.protocolReplay?.apiType === reasoningReplay ? [part.protocolReplay] : []);
    const reasoning = states.length
      ? states.flatMap(replayedReasoningText)
      : message.content.flatMap(part => part.kind === 'thinking' ? [part.value] : []);
    for (const value of reasoning) if (value) tokens += estimateTextTokens(value);
  }
  return tokens;
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
