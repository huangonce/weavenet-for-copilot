import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { RelayClient } from '../relay/client';
import {
  supportsImageInputForRoutedModel,
  supportsToolCallingForModel,
} from '../relay/models';
import type { ChatRequest, OpenAIUsage, ReasoningEffort, ResponsesRequest, RoutedModel } from '../relay/types';
import { toLanguageModelError } from './connection';
import {
  convertMessages,
  convertResponsesInput,
  convertResponsesTools,
  convertTools,
  RESPONSES_REASONING_METADATA_KEY,
} from './convert';
import {
  getConfiguredContextWindow,
  getConfiguredReasoningEffort,
  parseToolArguments,
} from './helpers';
import { createRequestDiagnostics } from './requestDiagnostics';
import type { DebugLogger } from './requestDiagnostics';
import type { CanonicalChatRequestSnapshot, CanonicalChatResponseOptions } from './canonicalRequest';
import { ResponsePartEmitter } from './responsePartEmitter';
import type { AdaptiveTokenUsage } from './tokenUsage';
import { createDeepSeekReplayPart, resolveDeepSeekChatPolicy } from './deepSeekChat';
import type { RequestDumpStore } from './requestDumpStore';
import { planToolListStabilization } from './toolStabilization';

const MAX_DEEPSEEK_REPLAY_BYTES = 4 * 1024 * 1024;

export interface OpenAIResponseContext {
  readonly config: ExtensionConfig;
  readonly routedModel: RoutedModel;
  readonly model: vscode.LanguageModelChatInformation;
  readonly messages: CanonicalChatRequestSnapshot;
  readonly options: CanonicalChatResponseOptions;
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly token: vscode.CancellationToken;
  readonly apiKey: string;
  readonly debug: DebugLogger;
  readonly tokenUsage: AdaptiveTokenUsage;
  readonly requestDumps: RequestDumpStore;
}

export async function provideOpenAIResponse(context: OpenAIResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug, tokenUsage, requestDumps } = context;
  const tools = supportsToolCallingForModel(routedModel, config)
    ? convertTools(options.tools, routedModel.openai?.strictTools === true)
    : undefined;
  const configuredReasoningEffort = getConfiguredReasoningEffort(routedModel, options);
  const deepSeek = resolveDeepSeekChatPolicy(
    config,
    routedModel,
    messages,
    tools?.map((tool) => tool.function.name) ?? [],
    configuredReasoningEffort,
  );
  if (deepSeek.enabled) {
    debug(
      config,
      `DeepSeek Chat policy: requestKind=${deepSeek.requestKind}, thinking=${deepSeek.thinking?.type ?? 'disabled'}, effort=${deepSeek.effort ?? 'none'}`,
    );
  }
  const stabilization = deepSeek.enabled
    ? planToolListStabilization(
      messages,
      tools?.map((tool) => tool.function.name) ?? [],
      config.stabilizeToolList,
    )
    : { messages, calls: [], round: 0 };
  if (stabilization.calls.length > 0) {
    debug(
      config,
      `DeepSeek tool-list preflight: round=${stabilization.round}, activators=${stabilization.calls.length}`,
    );
    for (const call of stabilization.calls) {
      progress.report(new vscode.LanguageModelToolCallPart(call.callId, call.name, {}));
    }
    return;
  }
  const upstreamMessages = stabilization.messages;
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });
  const promptCacheKey = config.openaiPromptCaching && supportsPromptCacheKey(routedModel)
    ? getOpenAIPromptCacheKey(config)
    : undefined;
  const convertedMessages = convertMessages(
    upstreamMessages,
    supportsImageInputForRoutedModel(routedModel, config),
    routedModel.openai?.developerRole === true,
    deepSeek.enabled,
  );
  const hasImageInput = convertedMessages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
  const contextWindow = getConfiguredContextWindow(routedModel, options);
  const reasoningEffort = deepSeek.effort;
  const tokenLimit = !hasImageInput && config.sendMaxTokens
    ? createTokenLimit(routedModel, model.maxOutputTokens ?? config.maxOutputTokens)
    : {};
  // Match VS Code's built-in Custom Endpoint payload for multimodal Chat
  // Completions. Optional relay hints can change upstream routing and are
  // deliberately omitted when an image is present.
  const request: ChatRequest = {
    model: routedModel.upstreamId,
    messages: convertedMessages,
    stream: true,
    temperature: config.temperature,
    // OpenAI recommends changing temperature or top_p, but not both.
    top_p: config.temperature === undefined ? config.topP : undefined,
    ...(tools?.length ? {
      tools,
      tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
    } : {}),
    ...tokenLimit,
    ...(!hasImageInput && routedModel.openai?.contextWindow === true && contextWindow ? { context_window: contextWindow } : {}),
    ...(!hasImageInput && deepSeek.thinking ? { thinking: deepSeek.thinking } : {}),
    ...(!hasImageInput && reasoningEffort && !deepSeek.enabled
      ? { reasoning_effort: reasoningEffort }
      : {}),
    ...(!hasImageInput && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(!hasImageInput && routedModel.openai?.store === true ? { store: false as const } : {}),
    ...(tools?.length && routedModel.openai?.parallelToolCalls === true ? { parallel_tool_calls: true } : {}),
    stream_options: { include_usage: true },
  };
  logOpenAIRequest(debug, config, request);
  void requestDumps.capture(config.debugMode, 'openai-chat', model.id, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'OpenAI', model.id, request.messages.length, request.tools?.length ?? 0);
  const output = new ResponsePartEmitter(progress);
  const usage = tokenUsage.begin(model.id, upstreamMessages);
  let deepSeekReasoning = '';
  let deepSeekReasoningBytes = 0;
  let deepSeekReplayOverflow = false;

  try {
    await client.streamChatCompletion(request, {
      onContent: (text) => {
        diagnostics.onContent();
        output.text(text);
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        output.thinking(text);
        if (deepSeek.enabled && !deepSeekReplayOverflow) {
          const textBytes = Buffer.byteLength(text, 'utf8');
          if (deepSeekReasoningBytes + textBytes <= MAX_DEEPSEEK_REPLAY_BYTES) {
            deepSeekReasoning += text;
            deepSeekReasoningBytes += textBytes;
          } else {
            deepSeekReasoning = '';
            deepSeekReasoningBytes = 0;
            deepSeekReplayOverflow = true;
          }
        }
      },
      onRequest: diagnostics.onRequest,
      onRequestSettled: diagnostics.onRequestSettled,
      onOpenAIUsage: (value) => {
        usage.recordOpenAI(value);
        logOpenAIUsage(debug, config, value, 'openai-chat');
      },
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onOpenAIFinishReason: diagnostics.onOpenAIFinishReason,
      onRefusal: (text) => {
        diagnostics.onRefusal();
        output.text(text);
      },
      onToolCall: (toolCall) => {
        const argumentsValue = parseToolArguments(toolCall.function.arguments);
        diagnostics.onToolCall();
        output.report(new vscode.LanguageModelToolCallPart(
          toolCall.id,
          toolCall.function.name,
          argumentsValue,
        ));
      },
    }, token, routedModel.openai?.clientRequestId === true);
    const replayPart = deepSeekReplayOverflow ? undefined : createDeepSeekReplayPart(deepSeekReasoning);
    if (replayPart) output.report(replayPart);
    const usagePart = usage.finish();
    if (usagePart) output.report(usagePart);
    output.flush();
    diagnostics.complete(output.reportCount);
  } catch (error) {
    if (token.isCancellationRequested) {
      output.discard();
      diagnostics.cancelled(output.reportCount);
      throw new vscode.CancellationError();
    }
    flushPartialOutput(output);
    diagnostics.failed(error, output.reportCount);
    throw toLanguageModelError(error);
  }
}

/**
 * OpenAI Responses API provider. Requests are stateless: `store` is always
 * disabled, `previous_response_id` is never sent, and a failed request never
 * falls back to Chat Completions. With the explicit `openai.encryptedReasoning`
 * capability the server's encrypted reasoning items are requested, carried
 * across turns on the thinking part, and replayed verbatim, which is how real
 * reasoning survives without server-side storage.
 */
export async function provideResponsesResponse(context: OpenAIResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug, tokenUsage, requestDumps } = context;
  const supportsImageInput = supportsImageInputForRoutedModel(routedModel, config);
  const tools = supportsToolCallingForModel(routedModel, config)
    ? convertResponsesTools(options.tools, routedModel.openai?.strictTools === true)
    : undefined;
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });
  const encryptedReasoning = routedModel.openai?.encryptedReasoning === true;
  const promptCacheKey = config.openaiPromptCaching && supportsPromptCacheKey(routedModel)
    ? getOpenAIPromptCacheKey(config)
    : undefined;
  const { input, instructions } = convertResponsesInput(
    messages,
    supportsImageInput,
    routedModel.openai?.replayReasoningContent === true,
    routedModel.openai?.assistantPhase === true,
    encryptedReasoning,
  );
  const hasImageInput = input.some((item) =>
    'content' in item && Array.isArray(item.content) && item.content.some((part) => part.type === 'input_image'));
  const reasoningEffort = getConfiguredReasoningEffort(routedModel, options);
  // Summaries are streamed as soon as the Responses API starts thinking, so they are
  // on by default; a gateway that rejects the field can opt out with an explicit false.
  const reasoningSummary = routedModel.openai?.reasoningSummary !== false;
  const tokenLimit = !hasImageInput && config.sendMaxTokens
    ? createResponsesTokenLimit(routedModel, model.maxOutputTokens ?? config.maxOutputTokens)
    : {};
  const request: ResponsesRequest = {
    model: routedModel.upstreamId,
    input,
    stream: true,
    store: false,
    ...(!hasImageInput && promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(encryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(instructions ? { instructions } : {}),
    temperature: config.temperature,
    // OpenAI recommends changing temperature or top_p, but not both.
    top_p: config.temperature === undefined ? config.topP : undefined,
    ...(tools?.length ? {
      tools,
      tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
    } : {}),
    ...tokenLimit,
    ...createResponsesReasoning(reasoningEffort, reasoningSummary),
    ...(tools?.length && routedModel.openai?.parallelToolCalls === true ? { parallel_tool_calls: true } : {}),
  };
  logResponsesRequest(debug, config, request);
  void requestDumps.capture(config.debugMode, 'openai-responses', model.id, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'Responses', model.id, input.length, request.tools?.length ?? 0);
  const output = new ResponsePartEmitter(progress);
  const usage = tokenUsage.begin(model.id, messages);

  try {
    await client.streamResponses(request, {
      onContent: (text) => {
        diagnostics.onContent();
        output.text(text);
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        output.thinking(text);
      },
      onResponsesReasoningItem: (item) => {
        // Parked on a metadata-only thinking part so the next turn can replay
        // the item verbatim; the payload stays opaque to the extension.
        if (!encryptedReasoning || !item.id || !item.encrypted_content) return;
        output.thinking('', item.id, {
          [RESPONSES_REASONING_METADATA_KEY]: {
            encryptedContent: item.encrypted_content,
            summary: item.summary ?? [],
          },
        });
      },
      onRequest: diagnostics.onRequest,
      onRequestSettled: diagnostics.onRequestSettled,
      onOpenAIUsage: (value) => {
        usage.recordOpenAI(value);
        logOpenAIUsage(debug, config, value, 'openai-responses');
      },
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onRefusal: (text) => {
        diagnostics.onRefusal();
        output.text(text);
      },
      onToolCall: (toolCall) => {
        const argumentsValue = parseToolArguments(toolCall.function.arguments);
        diagnostics.onToolCall();
        output.report(new vscode.LanguageModelToolCallPart(
          toolCall.id,
          toolCall.function.name,
          argumentsValue,
        ));
      },
    }, token, routedModel.openai?.clientRequestId === true);
    const usagePart = usage.finish();
    if (usagePart) output.report(usagePart);
    output.flush();
    diagnostics.complete(output.reportCount);
  } catch (error) {
    if (token.isCancellationRequested) {
      output.discard();
      diagnostics.cancelled(output.reportCount);
      throw new vscode.CancellationError();
    }
    flushPartialOutput(output);
    diagnostics.failed(error, output.reportCount);
    throw toLanguageModelError(error);
  }
}

function flushPartialOutput(output: ResponsePartEmitter): void {
  try {
    output.flush();
  } catch {
    // Preserve the request/transport failure that ended the stream. A progress
    // failure is already the primary error when it originated from flush().
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
  if (!config.debug) return;
  const bodyBytes = Buffer.byteLength(JSON.stringify(request));
  const imageParts = countOpenAIImages(request);
  debug(
    config,
    `OpenAI Chat Completions request: model=${request.model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, `
      + `imageParts=${imageParts}, promptCacheKey=${Boolean(request.prompt_cache_key)}, `
      + `streamUsage=${Boolean(request.stream_options?.include_usage)}, `
      + `thinking=${request.thinking?.type ?? 'standard'}, `
      + `customEndpointImageCompatibility=${imageParts > 0}, bodyBytes=${bodyBytes}`,
  );
}

function logResponsesRequest(debug: DebugLogger, config: ExtensionConfig, request: ResponsesRequest): void {
  if (!config.debug) return;
  const bodyBytes = Buffer.byteLength(JSON.stringify(request));
  const imageParts = countResponsesImages(request);
  debug(
    config,
    `OpenAI Responses request: model=${request.model}, inputItems=${typeof request.input === 'string' ? 1 : request.input.length}, `
      + `tools=${request.tools?.length ?? 0}, imageParts=${imageParts}, store=${Boolean(request.store)}, `
      + `promptCacheKey=${Boolean(request.prompt_cache_key)}, `
      + `encryptedReasoning=${request.include?.includes('reasoning.encrypted_content') ?? false}, `
      + `reasoningSummary=${request.reasoning?.summary ?? 'off'}, `
      + `replayedReasoningItems=${countReplayedReasoningItems(request)}, `
      + `bodyBytes=${bodyBytes}`,
  );
}

function countReplayedReasoningItems(request: ResponsesRequest): number {
  if (typeof request.input === 'string') return 0;
  return request.input.filter((item) => 'type' in item && item.type === 'reasoning' && Boolean(item.encrypted_content)).length;
}

function logOpenAIUsage(
  debug: DebugLogger,
  config: ExtensionConfig,
  usage: OpenAIUsage,
  protocol: 'openai-chat' | 'openai-responses',
): void {
  const apiName = protocol === 'openai-chat' ? 'OpenAI Chat Completions' : 'OpenAI Responses';
  debug(
    config,
    `${apiName} usage: prompt=${usage.prompt_tokens ?? 'n/a'}, `
      + `cached=${usage.prompt_tokens_details?.cached_tokens ?? 'n/a'}, `
      + `completion=${usage.completion_tokens ?? 'n/a'}, total=${usage.total_tokens ?? 'n/a'}, `
      + `reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}, `
      + `predictionAccepted=${usage.completion_tokens_details?.accepted_prediction_tokens ?? 'n/a'}, `
      + `predictionRejected=${usage.completion_tokens_details?.rejected_prediction_tokens ?? 'n/a'}`,
    'usage',
  );
}

function countOpenAIImages(request: ChatRequest): number {
  return request.messages.reduce((count, message) =>
    count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0), 0);
}

function countResponsesImages(request: ResponsesRequest): number {
  if (typeof request.input === 'string') return 0;
  return request.input.reduce((count, item) =>
    count + ('content' in item && Array.isArray(item.content)
      ? item.content.filter((part) => part.type === 'input_image').length
      : 0), 0);
}

function supportsPromptCacheKey(model: RoutedModel): boolean {
  if (model.openai?.promptCacheKey !== undefined) return model.openai.promptCacheKey;
  // Preserve 0.4.0 behavior for existing GPT Relay configurations.
  return model.upstreamId.toLowerCase().startsWith('gpt-');
}

function createTokenLimit(model: RoutedModel, value: number): Pick<ChatRequest, 'max_tokens' | 'max_completion_tokens'> {
  switch (model.openai?.tokenLimitField ?? 'max_tokens') {
    case 'max_completion_tokens': return { max_completion_tokens: value };
    case 'omit': return {};
    default: return { max_tokens: value };
  }
}

function createResponsesTokenLimit(model: RoutedModel, value: number): Pick<ResponsesRequest, 'max_output_tokens'> {
  return model.openai?.tokenLimitField === 'omit' ? {} : { max_output_tokens: value };
}

function createResponsesReasoning(
  effort: ReasoningEffort | undefined,
  summary: boolean,
): Pick<ResponsesRequest, 'reasoning'> {
  if (!effort && !summary) return {};
  return {
    reasoning: {
      ...(effort ? { effort } : {}),
      ...(summary ? { summary: 'auto' as const } : {}),
    },
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
