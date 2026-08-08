import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { RelayClient } from '../relay/client';
import { supportsImageInputForRoutedModel, supportsToolCallingForModel } from '../relay/models';
import type { ClaudeRequest, ClaudeUsage, RoutedModel } from '../relay/types';
import { convertClaudeMessages, convertClaudeTools } from './convert';
import { toLanguageModelError } from './connection';
import {
  clampClaudeTemperature,
  getConfiguredReasoningEffort,
  parseToolArguments,
  toClaudeThinking,
} from './helpers';
import { createRequestDiagnostics } from './requestDiagnostics';
import type { DebugLogger } from './requestDiagnostics';
import type { CanonicalChatRequestSnapshot, CanonicalChatResponseOptions } from './canonicalRequest';
import { ResponsePartEmitter } from './responsePartEmitter';
import type { AdaptiveTokenUsage } from './tokenUsage';
import type { RequestDumpStore } from './requestDumpStore';

export interface ClaudeResponseContext {
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

export async function provideClaudeResponse(context: ClaudeResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug, tokenUsage, requestDumps } = context;
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
  void requestDumps.capture(config.debugMode, 'claude', model.id, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'Claude', model.id, request.messages.length, request.tools?.length ?? 0);
  const output = new ResponsePartEmitter(progress);
  const usage = tokenUsage.begin(model.id, messages);
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
        output.text(text);
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        output.thinking(text);
      },
      onClaudeUsage: (value, responseId) => {
        usage.recordClaude(value);
        logClaudeUsage(debug, config, value, responseId);
      },
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onToolCall: (toolCall) => {
        diagnostics.onToolCall();
        output.report(new vscode.LanguageModelToolCallPart(
          toolCall.id,
          toolCall.function.name,
          parseToolArguments(toolCall.function.arguments),
        ));
      },
    }, token);
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
    try { output.flush(); } catch { /* Preserve the stream failure. */ }
    diagnostics.failed(error, output.reportCount);
    throw toLanguageModelError(error);
  }
}

function logClaudeRequest(debug: DebugLogger, config: ExtensionConfig, request: ClaudeRequest): void {
  if (!config.debug) return;
  const systemChars = typeof request.system === 'string'
    ? request.system.length
    : request.system?.reduce((total, block) => total + block.text.length, 0) ?? 0;
  debug(
    config,
    `Claude Messages request: model=${request.model}, cacheMode=${config.claudePromptCaching}, `
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
    `Claude Messages usage${responseId ? ` (${responseId})` : ''}: `
      + `input=${value(usage.input_tokens)}, cacheRead=${value(usage.cache_read_input_tokens)}, `
      + `cacheWrite=${value(usage.cache_creation_input_tokens)}, output=${value(usage.output_tokens)}, `
      + `usageFields=${fields}`,
    'usage',
  );
}
