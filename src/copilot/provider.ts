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
import { clampClaudeTemperature, convertClaudeMessages, convertClaudeTools } from '../relay/claude';
import { RelayClient } from '../relay/client';
import { RelayEndpointTestResult } from '../relay/client';
import { RelayRequestError, RelayStreamError } from '../relay/errors';
import { RelayTimeoutError } from '../relay/http';
import {
  assignUniquePickerIds,
  enrichModelsWithMetadata,
  filterModels,
  fromConfiguredModel,
  supportsImageInputForModel,
  supportsImageInputForRoutedModel,
  supportsToolCallingForModel,
  toChatInformation,
  toRoutedModel,
} from '../relay/models';
import { scheduleOpenRouterRefresh } from '../metadata/openrouterFallback';
import type {
  ChatRequest,
  ClaudeThinking,
  ClaudeRequest,
  ClaudeUsage,
  ModelProtocol,
  OpenAIUsage,
  ReasoningEffort,
  RelayModel,
  RoutedModel,
} from '../relay/types';
import { convertMessages, convertTools } from './convert';

type ModelOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

interface RequestDiagnostics {
  onContent(): void;
  onReasoning(): void;
  onToolCall(): void;
  onResponse(protocol: 'OpenAI' | 'Claude', status: number, contentType: string): void;
  onStreamEnd(protocol: 'OpenAI' | 'Claude', terminalEvent: '[DONE]' | 'finish_reason' | 'message_stop'): void;
  complete(): void;
  cancelled(): void;
  failed(error: unknown): void;
}

interface ModelLoadResult {
  readonly models: RoutedModel[];
  readonly snapshots: Map<RoutedModel['route'], RoutedModel[]>;
  readonly partial: boolean;
  readonly failedRoutes: Array<{ route: RoutedModel['route']; error: unknown }>;
}

type ModelRefreshIntent = 'passive' | 'invalidate';

export function shouldInvalidateModelRefresh(
  intent: ModelRefreshIntent,
  taskConnectionKey: string | undefined,
  connectionKey: string,
): boolean {
  return intent === 'invalidate' || taskConnectionKey !== connectionKey;
}

export function shouldApplyTestConnectionStatus(activeProfileName: string | undefined, testedProfileName: string): boolean {
  return activeProfileName === testedProfileName;
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

export interface ConnectionTestFailure {
  readonly category: 'url' | 'network' | 'timeout' | 'authentication' | 'notFound' | 'rateLimited' | 'server' | 'http' | 'unknown';
  readonly message: string;
  readonly status?: number;
  readonly responseType?: RelayRequestError['responseKind'];
  readonly requestId?: string;
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

  async refreshModels(intent: ModelRefreshIntent = 'passive'): Promise<void> {
    const config = getConfig();
    const connectionKey = modelConnectionKey(config);
    const connectionChanged = connectionKey !== this.cacheConnectionKey;
    if (connectionChanged) {
      this.cachedModels = [];
      this.routeModelSnapshots.clear();
      this.cacheConnectionKey = connectionKey;
      this.changeEmitter.fire();
    }
    if (!config.profileName || !config.baseUrl) {
      if (intent === 'invalidate' || !this.refreshModelsTask) this.requestModelRefresh(connectionKey);
      this.setConnectionStatus({ phase: 'unconfigured', modelCount: 0 });
      if (this.refreshModelsTask) return this.refreshModelsTask;
      return;
    }
    if (this.refreshModelsTask) {
      if (shouldInvalidateModelRefresh(intent, this.refreshTaskConnectionKey, connectionKey)) {
        this.requestModelRefresh(connectionKey);
      }
      return this.refreshModelsTask;
    }

    this.requestModelRefresh(connectionKey);
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

  private async refreshModelsUntilCurrent(): Promise<void> {
    let generation: number;
    do {
      generation = this.modelRefreshGeneration;
      try {
        await this.refreshModelsInternal(generation);
      } catch (error) {
        if (generation === this.modelRefreshGeneration) {
          const config = getConfig();
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
        this.setConnectionStatus({ ...connectionStatusFor(config), phase: 'keyMissing', modelCount: 0 });
      }
      return;
    }
    if (!this.isCurrentRefresh(generation, connectionKey)) {
      return;
    }
    this.setConnectionStatus({ ...connectionStatusFor(config), phase: 'refreshing', modelCount: this.cachedModels.length });

    const previousSnapshots = new Map(this.routeModelSnapshots);
    const result = await this.loadAllModels(config, previousSnapshots);
    if (!this.isCurrentRefresh(generation, connectionKey)) {
      return;
    }

    this.cachedModels = result.models;
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
    vscode.window.showInformationMessage(`WeaveNet loaded ${this.cachedModels.length} model(s).`);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void token;
    try {
      await this.refreshModels();
    } catch (error) {
      this.debug(getConfig(), `Model picker refresh failed: ${formatLogError(error)}`);
    }
    const config = getConfig();
    const hasApiKey = await this.auth.hasApiKey(config.profileName);
    const models = this.cacheConnectionKey === modelConnectionKey(config) ? this.cachedModels : [];
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
    const protocol: ModelProtocol = routedModel.protocol;

    if (protocol === 'claude') {
      await this.provideClaudeResponse(model, messages, options, progress, token);
      return;
    }

    await this.provideOpenAIResponse(model, messages, options, progress, token);
  }

  private async provideOpenAIResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = getConfig();
    const routedModel = this.cachedModels.find(
      (entry) => entry.pickerId === model.id,
    );
    if (!routedModel) {
      throw new vscode.LanguageModelError(`Unknown WeaveNet model route: ${model.id}`);
    }
    const apiKey = await this.auth.getApiKey(config.profileName);
    if (!apiKey) {
      throw new Error('WeaveNet Relay API key is not configured. Run WeaveNet: Set Relay API Key.');
    }

    const tools = !routedModel || supportsToolCallingForModel(routedModel, config)
      ? convertTools(options.tools)
      : undefined;
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
      requestTimeoutMs: config.requestTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });
    const promptCacheKey = config.openaiPromptCaching && isOpenAIPromptCacheModel(model.id)
      ? this.getOpenAIPromptCacheKey(config)
      : undefined;
    const supportsImageInput = routedModel
      ? supportsImageInputForRoutedModel(routedModel, config)
      : supportsImageInputForModel(model.id, config);
    const convertedMessages = convertMessages(messages, supportsImageInput);
    const hasImageInput = convertedMessages.some((message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
    // Match VS Code's built-in Custom Endpoint payload for multimodal Chat
    // Completions. Optional relay hints can change upstream routing and are
    // deliberately omitted when an image is present.
    const request: ChatRequest = {
      model: routedModel.upstreamId,
      messages: convertedMessages,
      stream: true,
      temperature: config.temperature,
      top_p: config.topP,
      ...(tools?.length ? {
        tools,
        tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      } : {}),
      ...(!hasImageInput && config.sendMaxTokens ? { max_tokens: model.maxOutputTokens ?? config.maxOutputTokens } : {}),
      ...(!hasImageInput && getConfiguredContextWindow(routedModel, options) ? { context_window: getConfiguredContextWindow(routedModel, options) } : {}),
      ...(!hasImageInput && getConfiguredReasoningEffort(routedModel, options) ? { reasoning_effort: getConfiguredReasoningEffort(routedModel, options) } : {}),
      ...(!hasImageInput && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      stream_options: { include_usage: true },
    };
    this.logOpenAIRequest(config, request);
    const diagnostics = this.createRequestDiagnostics(config, 'OpenAI', model.id, request.messages.length, request.tools?.length ?? 0);

    try {
      await client.streamChatCompletion(
        request,
        {
          onContent: (text) => {
            diagnostics.onContent();
            progress.report(new vscode.LanguageModelTextPart(text));
          },
          onReasoning: (text) => {
            diagnostics.onReasoning();
            reportThinking(progress, text);
          },
          onOpenAIUsage: (usage) => this.logOpenAIUsage(config, usage),
          onResponse: diagnostics.onResponse,
          onStreamEnd: diagnostics.onStreamEnd,
          onToolCall: (toolCall) => {
            diagnostics.onToolCall();
            progress.report(
              new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.function.name,
                parseToolArguments(toolCall.function.arguments),
              ),
            );
          },
        },
        token,
      );
      diagnostics.complete();
    } catch (error) {
      if (token.isCancellationRequested) {
        diagnostics.cancelled();
        throw new vscode.CancellationError();
      }
      diagnostics.failed(error);
      throw toLanguageModelError(error);
    }
  }

  private async provideClaudeResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = getConfig();
    const routedModel = this.cachedModels.find(
      (entry) => entry.pickerId === model.id,
    );
    if (!routedModel) {
      throw new vscode.LanguageModelError(`Unknown WeaveNet model route: ${model.id}`);
    }
    const apiKey = await this.auth.getApiKey(config.profileName);
    if (!apiKey) {
      throw new Error('WeaveNet Relay API key is not configured. Run WeaveNet: Set Relay API Key.');
    }

    const converted = convertClaudeMessages(messages, {
      supportsImageInput: routedModel
        ? supportsImageInputForRoutedModel(routedModel, config)
        : supportsImageInputForModel(model.id, config),
      promptCaching: config.claudePromptCaching !== 'disabled',
      cacheTTL: config.claudePromptCachingTTL,
    });
    const tools = !routedModel || supportsToolCallingForModel(routedModel, config)
      ? convertClaudeTools(options.tools, config.claudePromptCaching !== 'disabled', config.claudePromptCachingTTL)
      : undefined;
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
      authScheme: 'x-api-key',
      anthropicVersion: config.anthropicVersion,
      requestTimeoutMs: config.requestTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });

    const thinking = toClaudeThinking(
      getConfiguredReasoningEffort(routedModel, options),
      model.maxOutputTokens ?? config.maxOutputTokens,
    );
    const request: ClaudeRequest = {
      model: routedModel.upstreamId,
      max_tokens: model.maxOutputTokens ?? config.maxOutputTokens,
      messages: converted.messages,
      system: converted.system,
      stream: true,
      temperature: thinking ? undefined : clampClaudeTemperature(config.temperature),
      top_p: thinking ? undefined : config.topP,
      ...(tools?.length ? {
        tools,
        // Anthropic extended thinking is incompatible with forced tool choice.
        tool_choice: !thinking && options.toolMode === vscode.LanguageModelChatToolMode.Required ? { type: 'any' } : undefined,
      } : {}),
      ...thinking,
    };
    this.logClaudeRequest(config, request);
    const diagnostics = this.createRequestDiagnostics(config, 'Claude', model.id, request.messages.length, request.tools?.length ?? 0);

    try {
      await client.streamClaudeMessages(
        request,
        {
          onContent: (text) => {
            diagnostics.onContent();
            progress.report(new vscode.LanguageModelTextPart(text));
          },
          onReasoning: (text) => {
            diagnostics.onReasoning();
            reportThinking(progress, text);
          },
          onClaudeUsage: (usage, responseId) => this.logClaudeUsage(config, usage, responseId),
          onResponse: diagnostics.onResponse,
          onStreamEnd: diagnostics.onStreamEnd,
          onToolCall: (toolCall) => {
            diagnostics.onToolCall();
            progress.report(
              new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.function.name,
                parseToolArguments(toolCall.function.arguments),
              ),
            );
          },
        },
        token,
      );
      diagnostics.complete();
    } catch (error) {
      if (token.isCancellationRequested) {
        diagnostics.cancelled();
        throw new vscode.CancellationError();
      }
      diagnostics.failed(error);
      throw toLanguageModelError(error);
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

  private getOpenAIPromptCacheKey(config: ReturnType<typeof getConfig>): string {
    if (config.openaiPromptCacheKey) {
      return config.openaiPromptCacheKey;
    }

    const workspaceId = vscode.workspace.workspaceFolders
      ?.map((folder) => folder.uri.toString())
      .join('|') || 'no-workspace';
    return `weavenet-${hashString(workspaceId)}`;
  }

  private logOpenAIRequest(config: ReturnType<typeof getConfig>, request: ChatRequest): void {
    const bodyBytes = Buffer.byteLength(JSON.stringify(request));
    this.debug(
      config,
      `OpenAI request: model=${request.model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, `
        + `imageParts=${countOpenAIImages(request)}, promptCacheKey=${Boolean(request.prompt_cache_key)}, `
        + `streamUsage=${Boolean(request.stream_options?.include_usage)}, `
        + `customEndpointImageCompatibility=${countOpenAIImages(request) > 0}, bodyBytes=${bodyBytes}`,
    );
  }

  private logOpenAIUsage(config: ReturnType<typeof getConfig>, usage: OpenAIUsage): void {
    this.debug(
      config,
      `OpenAI usage: prompt=${usage.prompt_tokens ?? 'n/a'}, `
        + `cached=${usage.prompt_tokens_details?.cached_tokens ?? 'n/a'}, `
        + `completion=${usage.completion_tokens ?? 'n/a'}`,
    );
  }

  private logClaudeRequest(config: ReturnType<typeof getConfig>, request: ClaudeRequest): void {
    const systemChars = typeof request.system === 'string'
      ? request.system.length
      : request.system?.reduce((total, block) => total + block.text.length, 0) ?? 0;
    this.debug(
      config,
      `Claude request: model=${request.model}, cacheMode=${config.claudePromptCaching}, `
        + `messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, systemChars=${systemChars}, `
        + `bodyBytes=${Buffer.byteLength(JSON.stringify(request))}`,
    );
  }

  private logClaudeUsage(
    config: ReturnType<typeof getConfig>,
    usage: ClaudeUsage,
    responseId?: string,
  ): void {
    const value = (tokenCount: number | undefined): string => tokenCount === undefined ? 'n/a' : String(tokenCount);
    const fields = Object.keys(usage).sort().join(',') || 'none';
    this.debug(
      config,
      `Claude usage${responseId ? ` (${responseId})` : ''}: `
        + `input=${value(usage.input_tokens)}, cacheRead=${value(usage.cache_read_input_tokens)}, `
        + `cacheWrite=${value(usage.cache_creation_input_tokens)}, output=${value(usage.output_tokens)}, `
        + `usageFields=${fields}`,
    );
  }

  private createRequestDiagnostics(
    config: ReturnType<typeof getConfig>,
    protocol: 'OpenAI' | 'Claude',
    model: string,
    messageCount: number,
    toolCount: number,
  ): RequestDiagnostics {
    const startedAt = Date.now();
    let firstOutputAt: number | undefined;
    let contentParts = 0;
    let reasoningParts = 0;
    let toolCalls = 0;
    let responseStatus: number | undefined;
    let responseContentType: string | undefined;
    let terminalEvent: string | undefined;

    const elapsed = (): number => Date.now() - startedAt;
    const summary = (): string =>
      `protocol=${protocol} model=${model} messages=${messageCount} tools=${toolCount} `
        + `http=${responseStatus ?? 'n/a'} contentType=${responseContentType ?? 'n/a'} `
        + `ttfbMs=${firstOutputAt === undefined ? 'n/a' : firstOutputAt - startedAt} elapsedMs=${elapsed()} `
        + `parts={content:${contentParts},reasoning:${reasoningParts},tools:${toolCalls}}`
        + (terminalEvent ? ` terminal=${terminalEvent}` : '');
    const markFirstOutput = (): void => {
      firstOutputAt ??= Date.now();
    };

    this.debug(config, `${protocol} request started: model=${model}, messages=${messageCount}, tools=${toolCount}`);
    return {
      onContent: () => {
        markFirstOutput();
        contentParts++;
      },
      onReasoning: () => {
        markFirstOutput();
        reasoningParts++;
      },
      onToolCall: () => {
        markFirstOutput();
        toolCalls++;
      },
      onResponse: (_responseProtocol, status, contentType) => {
        responseStatus = status;
        responseContentType = contentType;
        this.debug(config, `${protocol} response: status=${status}, contentType=${contentType}, responseMs=${elapsed()}`);
      },
      onStreamEnd: (_responseProtocol, event) => {
        terminalEvent = event;
      },
      complete: () => this.debug(config, `${protocol} request completed: ${summary()}`),
      cancelled: () => this.debug(config, `${protocol} request cancelled: ${summary()}`),
      failed: (error) => this.debug(
        config,
        `${protocol} request failed: ${summary()} error=${formatLogError(error)}`,
      ),
    };
  }

  private debug(config: ReturnType<typeof getConfig>, message: string): void {
    if (config.debug) {
      this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  }

  private async loadAllModels(
    config: ReturnType<typeof getConfig>,
    previousSnapshots: ReadonlyMap<RoutedModel['route'], RoutedModel[]> = new Map(),
    token?: vscode.CancellationToken,
  ): Promise<ModelLoadResult> {
    const refreshMs = config.metadataRefreshHours * 3_600_000;
    void scheduleOpenRouterRefresh(refreshMs);

    const apiKey = await this.auth.getApiKey(config.profileName);
    const routes: Array<{ readonly name: RoutedModel['route']; readonly task: Promise<RoutedModel[]> }> = [];

    if (apiKey) {
      routes.push({
        name: 'openai',
        task: this.loadModelsForProtocol('openai', 'openai', apiKey, config, token),
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

    loaded.push(
      ...filterModels(
        enrichModelsWithMetadata(config.models.map(fromConfiguredModel)),
        config,
      ),
    );

    if (!loaded.length && routes.length > 0 && failedRouteCount === routes.length) {
      throw new Error('All model routes failed to refresh.');
    }

    const routed = assignUniquePickerIds(dedupeModels(loaded));
    return { models: routed, snapshots, partial: failedRouteCount > 0, failedRoutes };
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

  private async loadModelsForProtocol(
    protocol: ModelProtocol,
    route: RoutedModel['route'],
    apiKey: string,
    config: ReturnType<typeof getConfig>,
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
      toRoutedModel(model, isClaudeModel(model.id) ? 'claude' : 'openai', route),
    );
    // A shared /models catalog may advertise both OpenAI-compatible and native
    // Claude models. Route selection happens per model ID above, so filtering
    // it again by the discovery route would hide Claude entries.
    const filtered = filterModels(enrichModelsWithMetadata(routed), config);
    this.debug(config, `Models loaded: protocol=${protocol}, count=${filtered.length}, elapsedMs=${Date.now() - startedAt}`);
    return filtered;
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

export function safeHost(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.host || undefined : undefined;
  } catch {
    return undefined;
  }
}

export function safeEndpoint(baseUrl: string, path: string): string {
  try {
    const url = new URL(baseUrl);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    return url.toString();
  } catch {
    return path;
  }
}

export class ConnectionTestError extends Error {
  constructor(readonly failure: ConnectionTestFailure) {
    super(failure.message);
    this.name = 'ConnectionTestError';
  }
}

export function describeConnectionTestError(error: unknown): ConnectionTestFailure {
  if (error instanceof ConnectionTestError) return error.failure;
  if (error instanceof RelayRequestError) {
    const common = { status: error.status, responseType: error.responseKind, requestId: error.requestId };
    if (error.status === 401 || error.status === 403) return { ...common, category: 'authentication', message: 'API key was rejected or lacks permission.' };
    if (error.status === 404) return { ...common, category: 'notFound', message: 'The Relay does not expose a compatible endpoint at this path.' };
    if (error.status === 429) return { ...common, category: 'rateLimited', message: 'The Relay is rate-limiting requests. Try again later.' };
    if (error.status >= 500) return { ...common, category: 'server', message: 'The Relay or its upstream returned a server error.' };
    return { ...common, category: 'http', message: `The Relay returned HTTP ${error.status}.` };
  }
  if (error instanceof RelayTimeoutError) return { category: 'timeout', message: 'The Relay timed out before completing the request.' };
  if (error instanceof TypeError) return { category: 'network', message: 'Could not reach the Relay. Check the URL, DNS, TLS certificate, proxy, and network connection.' };
  return { category: 'unknown', message: 'The Relay connection could not be completed.' };
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof RelayRequestError) {
    if (error.status === 401 || error.status === 403) return 'Authentication was rejected by the Relay.';
    if (error.status === 404) return 'The Relay does not expose a compatible /models endpoint.';
    if (error.status === 429) return 'The Relay is rate-limiting requests.';
    if (error.status >= 500) return 'The Relay or its upstream returned a server error.';
    return `The Relay returned HTTP ${error.status}.`;
  }
  return 'The Relay connection could not be completed.';
}

function countOpenAIImages(request: ChatRequest): number {
  return request.messages.reduce((count, message) =>
    count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0), 0);
}

export function getConfiguredReasoningEffort(model: RoutedModel | undefined, options: ModelOptions): ReasoningEffort | undefined {
  if (!model?.thinking) return undefined;
  const value = options.modelOptions?.reasoningEffort ?? options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
  return isReasoningEffort(value) ? value : 'high';
}

export function getConfiguredContextWindow(model: RoutedModel | undefined, options: ModelOptions): number | undefined {
  if (!model?.contextWindows?.length) return undefined;
  const value = options.modelOptions?.contextWindow ?? options.modelConfiguration?.contextWindow ?? options.configuration?.contextWindow;
  if (typeof value !== 'string' || value === 'default') return undefined;
  const window = Number(value);
  return Number.isFinite(window) && model.contextWindows.includes(window) ? window : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

export function toClaudeThinking(effort: ReasoningEffort | undefined, maxTokens: number): { thinking: ClaudeThinking } | undefined {
  if (!effort) return undefined;
  const requested = { low: 1024, medium: 4096, high: 8192, xhigh: 12000, max: 16000 }[effort];
  const budget = Math.min(requested, Math.max(0, maxTokens - 1024));
  return budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : undefined;
}

function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('claude-');
}

function isOpenAIPromptCacheModel(modelId: string): boolean {
  return isGPTModel(modelId);
}

function isGPTModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('gpt-');
}

function isWeaveNetSecretKey(key: string): boolean {
  return key === RELAY_API_KEY_SECRET || key.startsWith(`${RELAY_API_KEY_SECRET}.profile.`) || key === LEGACY_API_KEY_SECRET || [
    OPENAI_API_KEY_SECRET,
    CHATGPT_API_KEY_SECRET,
    CLAUDE_API_KEY_SECRET,
  ].some((secretKey) => key === secretKey);
}

function formatLogError(error: unknown): string {
  if (error instanceof RelayRequestError) {
    const details = [
      `status=${error.status}`,
      `responseKind=${error.responseKind}`,
      error.upstreamType ? `upstreamType=${error.upstreamType}` : undefined,
      error.upstreamCode ? `upstreamCode=${error.upstreamCode}` : undefined,
      error.requestId ? `requestId=${error.requestId}` : undefined,
    ].filter(Boolean).join(', ');
    return `RelayRequestError(${details})`;
  }
  if (error instanceof RelayStreamError) {
    const details = [
      `protocol=${error.protocol}`,
      error.upstreamType ? `upstreamType=${error.upstreamType}` : undefined,
      error.upstreamCode ? `upstreamCode=${error.upstreamCode}` : undefined,
      error.requestId ? `requestId=${error.requestId}` : undefined,
    ].filter(Boolean).join(', ');
    return `RelayStreamError(${details})`;
  }
  if (error instanceof RelayTimeoutError) return 'RelayTimeoutError';
  if (error instanceof TypeError) return 'NetworkError';
  return error instanceof Error ? error.name : 'UnknownError';
}

export function toLanguageModelError(error: unknown): Error {
  if (error instanceof vscode.LanguageModelError || error instanceof vscode.CancellationError) return error;
  if (error instanceof RelayRequestError) {
    const suffix = [error.upstreamCode, error.requestId].filter(Boolean).join('/');
    const message = suffix ? `${error.message} [${suffix}]` : error.message;
    if (error.status === 401) return vscode.LanguageModelError.NoPermissions(message);
    if (error.status === 404) return vscode.LanguageModelError.NotFound(message);
    if (error.status === 403 || error.status === 429 || isQuotaError(error.upstreamCode, error.upstreamType, message)) {
      return vscode.LanguageModelError.Blocked(message);
    }
    return new vscode.LanguageModelError(message, {
      cause: error,
    });
  }
  if (error instanceof RelayStreamError) {
    if (error.rateLimited || isQuotaError(error.upstreamCode, error.upstreamType, error.message)) {
      return vscode.LanguageModelError.Blocked(error.message);
    }
    return new vscode.LanguageModelError(error.message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isQuotaError(...values: Array<string | undefined>): boolean {
  return /rate.?limit|quota|insufficient.?credit|billing|payment.?required/i.test(values.filter(Boolean).join(' '));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function dedupeModels(models: RoutedModel[]): RoutedModel[] {
  const byKey = new Map<string, RoutedModel>();
  for (const model of models) {
    byKey.set(`${model.route}:${model.upstreamId}`, model);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.protocol !== b.protocol) {
      return a.protocol === 'openai' ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

export function parseToolArguments(value: string): object {
  if (!value.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool call arguments must be a JSON object.');
    }
    return parsed;
  } catch {
    throw new Error('Relay returned invalid tool call arguments.');
  }
}

export function estimateTextTokens(value: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

function messageToText(message: vscode.LanguageModelChatRequestMessage): string {
  let result = '';
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      result += part.value;
    }
  }
  return result;
}

function reportThinking(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  text: string,
): void {
  const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart })
    .LanguageModelThinkingPart;
  progress.report(ThinkingPart ? new ThinkingPart(text) : new vscode.LanguageModelTextPart(text));
}
