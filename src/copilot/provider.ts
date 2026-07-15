import * as vscode from 'vscode';
import { AuthManager } from '../auth/auth';
import { getConfig } from '../config/config';
import {
  CHATGPT_API_KEY_SECRET,
  CLAUDE_API_KEY_SECRET,
  CONFIG_SECTION,
  LEGACY_API_KEY_SECRET,
  OPENAI_API_KEY_SECRET,
} from '../constants';
import { convertClaudeMessages, convertClaudeTools } from '../relay/claude';
import { RelayClient } from '../relay/client';
import { RelayRequestError, RelayStreamError } from '../relay/errors';
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

export class WeaveNetChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly output = vscode.window.createOutputChannel('WeaveNet');
  private readonly auth: AuthManager;
  private cachedModels: RoutedModel[] = [];
  private readonly routeModelSnapshots = new Map<RoutedModel['route'], RoutedModel[]>();
  private refreshModelsTask: Promise<void> | undefined;
  private modelRefreshGeneration = 0;
  private readonly refreshWarnings = new Set<string>();

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets);
    context.subscriptions.push(
      this.changeEmitter,
      this.output,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          void this.refreshModels();
        }
      }),
      context.secrets.onDidChange((event) => {
        if (
          event.key === OPENAI_API_KEY_SECRET ||
          event.key === CHATGPT_API_KEY_SECRET ||
          event.key === CLAUDE_API_KEY_SECRET ||
          event.key === LEGACY_API_KEY_SECRET
        ) {
          void this.refreshModels();
        }
      }),
    );
  }

  async configureOpenAIKey(): Promise<void> {
    if (await this.auth.promptForApiKey('openai')) {
      await this.refreshModels();
    }
  }

  async configureClaudeKey(): Promise<void> {
    if (await this.auth.promptForApiKey('claude')) {
      await this.refreshModels();
    }
  }

  async configureChatGPTKey(): Promise<void> {
    if (await this.auth.promptForApiKey('chatgpt')) {
      await this.refreshModels();
    }
  }

  async clearOpenAIKey(): Promise<void> {
    await this.auth.clearApiKey('openai');
    await this.refreshModels();
  }

  async clearClaudeKey(): Promise<void> {
    await this.auth.clearApiKey('claude');
    await this.refreshModels();
  }

  async clearChatGPTKey(): Promise<void> {
    await this.auth.clearApiKey('chatgpt');
    await this.refreshModels();
  }

  async refreshModels(): Promise<void> {
    this.modelRefreshGeneration++;
    if (this.refreshModelsTask) {
      return this.refreshModelsTask;
    }

    this.refreshModelsTask = this.refreshModelsUntilCurrent()
      .finally(() => {
        this.refreshModelsTask = undefined;
      });
    return this.refreshModelsTask;
  }

  private async refreshModelsUntilCurrent(): Promise<void> {
    let generation: number;
    do {
      generation = this.modelRefreshGeneration;
      try {
        await this.refreshModelsInternal(generation);
      } catch (error) {
        if (generation === this.modelRefreshGeneration) {
          throw error;
        }
      }
    } while (generation !== this.modelRefreshGeneration);
  }

  private async refreshModelsInternal(generation: number): Promise<void> {
    const config = getConfig();
    if (!config.baseUrl) {
      if (generation === this.modelRefreshGeneration) {
        this.changeEmitter.fire();
      }
      return;
    }

    const models = await this.loadAllModels(config);
    if (generation !== this.modelRefreshGeneration) {
      return;
    }

    this.cachedModels = models;
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`WeaveNet loaded ${this.cachedModels.length} model(s).`);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getConfig();

    if (this.cachedModels.length === 0 && config.baseUrl) {
      const generation = this.modelRefreshGeneration;
      try {
        const models = await this.loadAllModels(config, token);
        if (generation === this.modelRefreshGeneration) {
          this.cachedModels = models;
        }
      } catch (error) {
        if (generation === this.modelRefreshGeneration) {
          console.error('Failed to load WeaveNet models', error);
        }
      }
    }

    const keyAvailability = new Map<RoutedModel['route'], boolean>(await Promise.all(
      (['openai', 'chatgpt', 'claude'] as const).map(async (route) => [route, await this.auth.hasApiKey(route)] as const),
    ));
    return this.cachedModels.map((model) => toChatInformation(model, config, keyAvailability.get(model.route) === true));
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
      throw new Error('weavenet-copilot.baseUrl is not configured.');
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
    const protocol = routedModel.route;
    const apiKey = await this.auth.getApiKey(protocol);
    if (!apiKey) {
      const command = protocol === 'chatgpt' ? 'WeaveNet: Set ChatGPT API Key' : 'WeaveNet: Set OpenAI API Key';
      throw new Error(`WeaveNet ${protocol === 'chatgpt' ? 'ChatGPT' : 'OpenAI'} API key is not configured. Run ${command}.`);
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
    const apiKey = await this.auth.getApiKey(routedModel.route);
    if (!apiKey) {
      throw new Error('WeaveNet Claude API key is not configured. Run WeaveNet: Set Claude API Key.');
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

    const request: ClaudeRequest = {
      model: routedModel.upstreamId,
      max_tokens: model.maxOutputTokens ?? config.maxOutputTokens,
      messages: converted.messages,
      system: converted.system,
      stream: true,
      temperature: config.temperature,
      top_p: config.topP,
      ...(tools?.length ? {
        tools,
        tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? { type: 'any' } : undefined,
      } : {}),
      ...(toClaudeThinking(getConfiguredReasoningEffort(routedModel, options), model.maxOutputTokens ?? config.maxOutputTokens)),
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
    token?: vscode.CancellationToken,
  ): Promise<RoutedModel[]> {
    const refreshMs = config.metadataRefreshHours * 3_600_000;
    void scheduleOpenRouterRefresh(refreshMs);

    const [openaiKey, chatgptKey, claudeKey] = await Promise.all([
      this.auth.getApiKey('openai'),
      this.auth.getApiKey('chatgpt'),
      this.auth.getApiKey('claude'),
    ]);
    const routes: Array<{ readonly name: RoutedModel['route']; readonly task: Promise<RoutedModel[]> }> = [];

    if (openaiKey) {
      routes.push({
        name: 'openai',
        task: this.loadModelsForProtocol('openai', 'openai', openaiKey, config, token)
            .then((models) => models.filter((model) => !isGPTModel(model.id) && !isClaudeModel(model.id))),
      });
    }
    if (chatgptKey) {
      routes.push({
        name: 'chatgpt',
        task: this.loadModelsForProtocol('openai', 'chatgpt', chatgptKey, config, token)
          .then((models) => models.filter((model) => isGPTModel(model.id))),
      });
    }
    if (claudeKey) {
      routes.push({
        name: 'claude',
        task: this.loadModelsForProtocol('claude', 'claude', claudeKey, config, token),
      });
    }

    const results = await Promise.allSettled(routes.map((route) => route.task));
    const loaded: RoutedModel[] = [];
    let failedRouteCount = 0;
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const route = routes[index].name;
      if (result.status === 'fulfilled') {
        this.routeModelSnapshots.set(route, result.value);
        this.clearRouteRefreshWarnings(route);
        loaded.push(...result.value);
      } else {
        failedRouteCount++;
        this.reportRouteRefreshFailure(route, result.reason);
        loaded.push(...(this.routeModelSnapshots.get(route) ?? []));
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
    return routed;
  }

  private reportRouteRefreshFailure(route: RoutedModel['route'], error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${route}:${message}`;
    if (!this.refreshWarnings.has(key)) {
      this.refreshWarnings.add(key);
      this.output.appendLine(
        `[models] ${route} route unavailable; continuing with successful routes: ${message.slice(0, 240)}`,
      );
    }
  }

  private clearRouteRefreshWarnings(route: RoutedModel['route']): void {
    for (const key of this.refreshWarnings) {
      if (key.startsWith(`${route}:`)) this.refreshWarnings.delete(key);
    }
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
        toRoutedModel(model, protocol === 'claude' || isClaudeModel(model.id) ? 'claude' : 'openai', route),
    );
    const filtered = filterModels(enrichModelsWithMetadata(routed), config, protocol);
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

function countOpenAIImages(request: ChatRequest): number {
  return request.messages.reduce((count, message) =>
    count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0), 0);
}

function getConfiguredReasoningEffort(model: RoutedModel | undefined, options: ModelOptions): ReasoningEffort | undefined {
  if (!model?.thinking) return undefined;
  const value = options.modelOptions?.reasoningEffort ?? options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
  return isReasoningEffort(value) ? value : 'high';
}

function getConfiguredContextWindow(model: RoutedModel | undefined, options: ModelOptions): number | undefined {
  if (!model?.contextWindows?.length) return undefined;
  const value = options.modelOptions?.contextWindow ?? options.modelConfiguration?.contextWindow ?? options.configuration?.contextWindow;
  if (typeof value !== 'string' || value === 'default') return undefined;
  const window = Number(value);
  return Number.isFinite(window) && model.contextWindows.includes(window) ? window : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

function toClaudeThinking(effort: ReasoningEffort | undefined, maxTokens: number): { thinking: ClaudeThinking } | undefined {
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

function formatLogError(error: unknown): string {
  if (error instanceof RelayRequestError) {
    return `RelayRequestError(status=${error.status}, responseKind=${error.responseKind})`;
  }
  if (error instanceof RelayStreamError) {
    return `RelayStreamError(protocol=${error.protocol})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${error instanceof Error ? error.name : 'UnknownError'}(${message.replace(/\s+/g, ' ').trim().slice(0, 200)})`;
}

function toLanguageModelError(error: unknown): Error {
  if (error instanceof vscode.LanguageModelError || error instanceof vscode.CancellationError) return error;
  if (error instanceof RelayRequestError) {
    const suffix = [error.upstreamCode, error.requestId].filter(Boolean).join('/');
    const message = suffix ? `${error.message} [${suffix}]` : error.message;
    return new vscode.LanguageModelError(message, {
      cause: error,
    });
  }
  if (error instanceof RelayStreamError) {
    return new vscode.LanguageModelError(error.message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
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

function parseToolArguments(value: string): object {
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

function estimateTextTokens(value: string): number {
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
