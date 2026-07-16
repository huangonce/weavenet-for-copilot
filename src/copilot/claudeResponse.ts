import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { clampClaudeTemperature, convertClaudeMessages, convertClaudeTools } from '../relay/claude';
import { RelayClient } from '../relay/client';
import { supportsImageInputForRoutedModel, supportsToolCallingForModel } from '../relay/models';
import type { ClaudeRequest, ClaudeUsage, RoutedModel } from '../relay/types';
import { toLanguageModelError } from './connection';
import {
  getConfiguredReasoningEffort,
  parseToolArguments,
  reportThinking,
  toClaudeThinking,
} from './helpers';
import type { ModelOptions } from './helpers';
import { createRequestDiagnostics } from './requestDiagnostics';
import type { DebugLogger } from './requestDiagnostics';

export interface ClaudeResponseContext {
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

export async function provideClaudeResponse(context: ClaudeResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug } = context;
  const converted = convertClaudeMessages(messages, {
    supportsImageInput: supportsImageInputForRoutedModel(routedModel, config),
    promptCaching: config.claudePromptCaching !== 'disabled',
    cacheTTL: config.claudePromptCachingTTL,
  });
  const tools = supportsToolCallingForModel(routedModel, config)
    ? convertClaudeTools(options.tools, config.claudePromptCaching !== 'disabled', config.claudePromptCachingTTL)
    : undefined;
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
      tool_choice: !thinking && options.toolMode === vscode.LanguageModelChatToolMode.Required
        ? { type: 'any' as const }
        : undefined,
    } : {}),
    ...thinking,
  };
  logClaudeRequest(debug, config, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'Claude', model.id, request.messages.length, request.tools?.length ?? 0);
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    authScheme: 'x-api-key',
    anthropicVersion: config.anthropicVersion,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });

  try {
    await client.streamClaudeMessages(request, {
      onContent: (text) => {
        diagnostics.onContent();
        progress.report(new vscode.LanguageModelTextPart(text));
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        reportThinking(progress, text);
      },
      onClaudeUsage: (usage, responseId) => logClaudeUsage(debug, config, usage, responseId),
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onToolCall: (toolCall) => {
        diagnostics.onToolCall();
        progress.report(new vscode.LanguageModelToolCallPart(
          toolCall.id,
          toolCall.function.name,
          parseToolArguments(toolCall.function.arguments),
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

function logClaudeRequest(debug: DebugLogger, config: ExtensionConfig, request: ClaudeRequest): void {
  const systemChars = typeof request.system === 'string'
    ? request.system.length
    : request.system?.reduce((total, block) => total + block.text.length, 0) ?? 0;
  debug(
    config,
    `Claude request: model=${request.model}, cacheMode=${config.claudePromptCaching}, `
      + `messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, systemChars=${systemChars}, `
      + `bodyBytes=${Buffer.byteLength(JSON.stringify(request))}`,
  );
}

function logClaudeUsage(
  debug: DebugLogger,
  config: ExtensionConfig,
  usage: ClaudeUsage,
  responseId?: string,
): void {
  const value = (tokenCount: number | undefined): string => tokenCount === undefined ? 'n/a' : String(tokenCount);
  const fields = Object.keys(usage).sort().join(',') || 'none';
  debug(
    config,
    `Claude usage${responseId ? ` (${responseId})` : ''}: `
      + `input=${value(usage.input_tokens)}, cacheRead=${value(usage.cache_read_input_tokens)}, `
      + `cacheWrite=${value(usage.cache_creation_input_tokens)}, output=${value(usage.output_tokens)}, `
      + `usageFields=${fields}`,
  );
}
