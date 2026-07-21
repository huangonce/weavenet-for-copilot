import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { RelayClient } from '../relay/client';
import {
  supportsImageInputForRoutedModel,
  supportsToolCallingForModel,
} from '../relay/models';
import type { ChatRequest, OpenAIUsage, RoutedModel } from '../relay/types';
import { toLanguageModelError } from './connection';
import { convertMessages, convertTools } from './convert';
import {
  getConfiguredContextWindow,
  getConfiguredReasoningEffort,
  parseToolArguments,
  reportThinking,
} from './helpers';
import type { ModelOptions } from './helpers';
import { createRequestDiagnostics } from './requestDiagnostics';
import type { DebugLogger } from './requestDiagnostics';

export interface OpenAIResponseContext {
  readonly config: ExtensionConfig;
  readonly routedModel: RoutedModel;
  readonly model: vscode.LanguageModelChatInformation;
  readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
  readonly options: ModelOptions;
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly token: vscode.CancellationToken;
  readonly apiKey: string;
  readonly debug: DebugLogger;
}

export async function provideOpenAIResponse(context: OpenAIResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug } = context;
  const tools = supportsToolCallingForModel(routedModel, config) ? convertTools(options.tools) : undefined;
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });
  const promptCacheKey = config.openaiPromptCaching && isOpenAIPromptCacheModel(routedModel.upstreamId)
    ? getOpenAIPromptCacheKey(config)
    : undefined;
  const convertedMessages = convertMessages(messages, supportsImageInputForRoutedModel(routedModel, config));
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
  logOpenAIRequest(debug, config, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'OpenAI', model.id, request.messages.length, request.tools?.length ?? 0);

  try {
    await client.streamChatCompletion(request, {
      onContent: (text) => {
        diagnostics.onContent();
        progress.report(new vscode.LanguageModelTextPart(text));
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        reportThinking(progress, text);
      },
      onOpenAIUsage: (usage) => logOpenAIUsage(debug, config, usage),
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onToolCall: (toolCall) => {
        const argumentsValue = parseToolArguments(toolCall.function.arguments);
        diagnostics.onToolCall();
        progress.report(new vscode.LanguageModelToolCallPart(
          toolCall.id,
          toolCall.function.name,
          argumentsValue,
        ));
      },
    }, token);
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

function getOpenAIPromptCacheKey(config: ExtensionConfig): string {
  if (config.openaiPromptCacheKey) return config.openaiPromptCacheKey;
  const workspaceId = vscode.workspace.workspaceFolders
    ?.map((folder) => folder.uri.toString())
    .join('|') || 'no-workspace';
  return `weavenet-${hashString(workspaceId)}`;
}

function logOpenAIRequest(debug: DebugLogger, config: ExtensionConfig, request: ChatRequest): void {
  const bodyBytes = Buffer.byteLength(JSON.stringify(request));
  const imageParts = countOpenAIImages(request);
  debug(
    config,
    `OpenAI request: model=${request.model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, `
      + `imageParts=${imageParts}, promptCacheKey=${Boolean(request.prompt_cache_key)}, `
      + `streamUsage=${Boolean(request.stream_options?.include_usage)}, `
      + `customEndpointImageCompatibility=${imageParts > 0}, bodyBytes=${bodyBytes}`,
  );
}

function logOpenAIUsage(debug: DebugLogger, config: ExtensionConfig, usage: OpenAIUsage): void {
  debug(
    config,
    `OpenAI usage: prompt=${usage.prompt_tokens ?? 'n/a'}, `
      + `cached=${usage.prompt_tokens_details?.cached_tokens ?? 'n/a'}, `
      + `completion=${usage.completion_tokens ?? 'n/a'}`,
  );
}

function countOpenAIImages(request: ChatRequest): number {
  return request.messages.reduce((count, message) =>
    count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0), 0);
}

function isOpenAIPromptCacheModel(modelId: string): boolean {
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
