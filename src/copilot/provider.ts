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
import { RelayClient } from '../relay/client';
import {
  enrichModelsWithMetadata,
  filterModels,
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
import { convertClaudeMessages, convertClaudeTools, convertMessages, convertTools } from './convert';

type ModelOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

export class WeaveNetChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly output = vscode.window.createOutputChannel('WeaveNet');
  private readonly auth: AuthManager;
  private cachedModels: RoutedModel[] = [];

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
    const config = getConfig();
    if (!config.baseUrl) {
      this.changeEmitter.fire();
      return;
    }

    this.cachedModels = await this.loadAllModels(config);
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`WeaveNet loaded ${this.cachedModels.length} model(s).`);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const config = getConfig();

    if (this.cachedModels.length === 0 && config.baseUrl) {
      try {
        this.cachedModels = await this.loadAllModels(config, token);
      } catch (error) {
        console.error('Failed to load WeaveNet models', error);
      }
    }

    return this.cachedModels.map((model) => {
      const information = toChatInformation(model, config, true);
      this.debug(
        config,
        `Picker pricing: id=${model.id}, input=${information.inputCost ?? 'n/a'}, `
          + `output=${information.outputCost ?? 'n/a'}, cache=${information.cacheCost ?? 'n/a'}, `
          + `imageAdvertised=${information.capabilities.imageInput === true}`,
      );
      return information;
    });
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

    if (isClaudeModel(model.id)) {
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
    const keyKind = isGPTModel(model.id) ? 'chatgpt' : 'openai';
    const apiKey = await this.auth.getApiKey(keyKind);
    if (!apiKey) {
      const command = keyKind === 'chatgpt' ? 'WeaveNet: Set ChatGPT API Key' : 'WeaveNet: Set OpenAI API Key';
      throw new Error(`WeaveNet ${keyKind === 'chatgpt' ? 'ChatGPT' : 'OpenAI'} API key is not configured. Run ${command}.`);
    }

    const routedModel = this.cachedModels.find((candidate) => candidate.id === model.id && candidate.protocol === 'openai');
    const tools = !routedModel || supportsToolCallingForModel(routedModel, config)
      ? convertTools(options.tools)
      : undefined;
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
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
      model: model.id,
      messages: convertedMessages,
      stream: true,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...(!hasImageInput && config.sendMaxTokens ? { max_tokens: model.maxOutputTokens ?? config.maxOutputTokens } : {}),
      ...(!hasImageInput && getConfiguredContextWindow(routedModel, options) ? { context_window: getConfiguredContextWindow(routedModel, options) } : {}),
      ...(!hasImageInput && getConfiguredReasoningEffort(routedModel, options) ? { reasoning_effort: getConfiguredReasoningEffort(routedModel, options) } : {}),
      ...(!hasImageInput && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      stream_options: { include_usage: true },
    };
    this.logOpenAIRequest(config, request);

    await client.streamChatCompletion(
      request,
      {
        onContent: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
        onReasoning: (text) => reportThinking(progress, text),
        onOpenAIUsage: (usage) => this.logOpenAIUsage(config, usage),
        onToolCall: (toolCall) =>
          progress.report(
            new vscode.LanguageModelToolCallPart(
              toolCall.id,
              toolCall.function.name,
              parseToolArguments(toolCall.function.arguments),
            ),
          ),
      },
      token,
    );
  }

  private async provideClaudeResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = getConfig();
    const apiKey = await this.auth.getApiKey('claude');
    if (!apiKey) {
      throw new Error('WeaveNet Claude API key is not configured. Run WeaveNet: Set Claude API Key.');
    }

    const routedModel = this.cachedModels.find((candidate) => candidate.id === model.id && candidate.protocol === 'claude');
    const converted = convertClaudeMessages(messages, {
      supportsImageInput: routedModel
        ? supportsImageInputForRoutedModel(routedModel, config)
        : supportsImageInputForModel(model.id, config),
    });
    const tools = !routedModel || supportsToolCallingForModel(routedModel, config)
      ? convertClaudeTools(options.tools)
      : undefined;
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
      authScheme: 'x-api-key',
      anthropicVersion: config.anthropicVersion,
    });

    const request: ClaudeRequest = {
      model: model.id,
      max_tokens: model.maxOutputTokens ?? config.maxOutputTokens,
      messages: converted.messages,
      system: converted.system,
      stream: true,
      ...(tools?.length ? { tools } : {}),
      ...(config.claudePromptCaching === 'automatic'
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
      ...(toClaudeThinking(getConfiguredReasoningEffort(routedModel, options), model.maxOutputTokens ?? config.maxOutputTokens)),
    };
    this.logClaudeRequest(config, request);

    try {
      await client.streamClaudeMessages(
        request,
        {
          onContent: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
          onReasoning: (text) => reportThinking(progress, text),
          onClaudeUsage: (usage, responseId) => this.logClaudeUsage(config, usage, responseId),
          onToolCall: (toolCall) =>
            progress.report(
              new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.function.name,
                parseToolArguments(toolCall.function.arguments),
              ),
            ),
        },
        token,
      );
    } catch (error) {
      this.debug(config, `Claude request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
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
    this.debug(
      config,
      `OpenAI request: model=${request.model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, `
        + `imageParts=${countOpenAIImages(request)}, promptCacheKey=${Boolean(request.prompt_cache_key)}, `
        + `streamUsage=${Boolean(request.stream_options?.include_usage)}, `
        + `customEndpointImageCompatibility=${countOpenAIImages(request) > 0}`,
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
        + `cachePoints={topLevel:${Boolean(request.cache_control)}}`,
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
    const loaded: RoutedModel[] = [];

    if (openaiKey) {
      const models = await this.loadModelsForProtocol('openai', openaiKey, config, token);
      loaded.push(...models.filter((model) => !isGPTModel(model.id)));
    }
    if (chatgptKey) {
      const models = await this.loadModelsForProtocol('openai', chatgptKey, config, token);
      loaded.push(...models.filter((model) => isGPTModel(model.id)));
    }
    if (claudeKey) {
      loaded.push(...await this.loadModelsForProtocol('claude', claudeKey, config, token));
    }

    return dedupeModels(loaded);
  }

  private async loadModelsForProtocol(
    protocol: ModelProtocol,
    apiKey: string,
    config: ReturnType<typeof getConfig>,
    token?: vscode.CancellationToken,
  ): Promise<RoutedModel[]> {
    const client = new RelayClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestHeaders: config.requestHeaders,
      authScheme: protocol === 'claude' ? 'x-api-key' : 'bearer',
      anthropicVersion: config.anthropicVersion,
    });
    const response = await client.listModels(token);
    const routed = (response.data ?? []).map((model: RelayModel) =>
      toRoutedModel(model, protocol === 'claude' || isClaudeModel(model.id) ? 'claude' : 'openai'),
    );
    const filtered = filterModels(enrichModelsWithMetadata(routed), config, protocol);
    for (const model of filtered) {
      this.debug(
        config,
        `Model metadata: id=${model.id}, image=${model.imageInput === true}, tools=${model.toolCalling !== false}, `
          + `context=${model.maxInputTokens ?? 'n/a'}, pricing=${JSON.stringify(model.referencePricing)}, sources=${JSON.stringify(model.metadataSources)}`,
      );
    }
    return filtered;
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const value = typeof text === 'string' ? text : messageToText(text);
    return Math.ceil(value.length / 4);
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
    byKey.set(`${model.protocol}:${model.id}`, model);
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
    return JSON.parse(value) as object;
  } catch {
    return { input: value };
  }
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
