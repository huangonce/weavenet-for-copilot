import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { RelayClient } from '../relay/client';
import { supportsImageInputForRoutedModel, supportsToolCallingForModel } from '../relay/models';
import type { ClaudeRequest, ClaudeUsage, RoutedModel } from '../relay/types';
import { convertClaudeMessages, convertClaudeTools } from './convert';
import { claudePrefix, validateClaudePrefixes } from './claudePrefix';
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
import { cloneReplayState, ReplayBudget } from '../relay/replayState';
import { hasProtocolReplayCarrier, prepareProtocolTools, reconcileProtocolText, reportProtocolReplay, warnProtocolReplayUnavailable } from './protocolState';
import type { ClaudeContentBlock, ToolCall } from '../relay/types';
import { ResponsePartEmitter } from './responsePartEmitter';

export interface ClaudeResponseContext {
  readonly config: ExtensionConfig;
  readonly routedModel: RoutedModel;
  readonly model: vscode.LanguageModelChatInformation;
  readonly messages: CanonicalChatRequestSnapshot;
  readonly options: CanonicalChatResponseOptions;
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly token: vscode.CancellationToken;
  readonly apiKey: string;
  readonly protocolIdentity: string;
  readonly debug: DebugLogger;
}

export async function provideClaudeResponse(context: ClaudeResponseContext): Promise<void> {
  const { config, routedModel, model, messages, options, progress, token, apiKey, debug } = context;
  // Without the host carrier no signed thinking block can survive a turn, so
  // native thinking is disabled for the request instead of failing it.
  const replayAvailable = hasProtocolReplayCarrier();
  if (!replayAvailable) warnProtocolReplayUnavailable('Claude');
  const tools = supportsToolCallingForModel(routedModel, config)
    ? convertClaudeTools(options.tools, config.claudePromptCaching !== 'disabled', config.claudePromptCachingTTL)
    : undefined;
  const required = !!tools?.length && options.toolMode === vscode.LanguageModelChatToolMode.Required;
  const manual = (routedModel.claude?.thinkingMode ?? 'manual') === 'manual';
  const forcedAllowed = routedModel.claude?.forcedToolChoice ?? (routedModel.claude?.thinkingMode === 'manual');
  if (required && !forcedAllowed) throw new vscode.LanguageModelError('This model has not declared support for Required/forced tool choice. Select Auto tool mode or a supported model.');
  const thinking = !replayAvailable || (required && manual) ? undefined : toClaudeThinking(
    getConfiguredReasoningEffort(routedModel, options), model.maxOutputTokens ?? config.maxOutputTokens,
    routedModel.claude?.thinkingMode ?? 'manual',
  );
  const lastAssistant = [...messages.messages].reverse().find((message) => message.role === 'assistant');
  const continuingThinking = lastAssistant?.content.some((part) => part.kind === 'thinking'
    && part.protocolReplay?.apiType === 'messages' && part.protocolReplay.identity === context.protocolIdentity
    && part.protocolReplay.claude?.some((block) => block.type === 'tool_use')
    && part.protocolReplay.claude.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking'));
  if (continuingThinking && !thinking) throw new vscode.LanguageModelError(
    'Thinking cannot be disabled during a native thinking tool continuation. Use Auto tool mode with thinking, or start a new conversation.',
  );
  const converted = convertClaudeMessages(messages, {
    supportsImageInput: supportsImageInputForRoutedModel(routedModel, config),
    promptCaching: config.claudePromptCaching !== 'disabled', cacheTTL: config.claudePromptCachingTTL,
    protocolIdentity: context.protocolIdentity, requiresThinkingState: !!thinking,
  });
  const request: ClaudeRequest = {
    model: routedModel.upstreamId,
    max_tokens: model.maxOutputTokens ?? config.maxOutputTokens,
    messages: converted.messages,
    system: converted.system,
    stream: true,
    temperature: !thinking && (routedModel.claude?.sampling ?? (routedModel.claude?.thinkingMode === 'manual')) ? clampClaudeTemperature(config.temperature) : undefined,
    top_p: !thinking && config.temperature === undefined && (routedModel.claude?.sampling ?? (routedModel.claude?.thinkingMode === 'manual')) ? config.topP : undefined,
    ...(tools?.length ? {
      tools,
      // Anthropic extended thinking is incompatible with forced tool choice.
      tool_choice: required
        ? { type: 'any' as const }
        : undefined,
    } : {}),
    ...thinking,
  };
  validateClaudePrefixes(messages, request, context.protocolIdentity);
  const signedPrefix = claudePrefix(request);
  logClaudeRequest(debug, config, request);
  const diagnostics = createRequestDiagnostics(debug, config, 'Claude', model.id, request.messages.length, request.tools?.length ?? 0);
  const output = new ResponsePartEmitter(progress);
  const replayBudget = new ReplayBudget();
  let replyText = '';
  let hasThinking = false;
  let stopReason: string | undefined;
  let replyContent: readonly ClaudeContentBlock[] | undefined;
  const pendingTools: ToolCall[] = [];
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
        replayBudget.reserve(text); replyText += text;
        output.text(text);
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        hasThinking = true; replayBudget.reserve(text);
        output.thinking(text);
      },
      onClaudeStopReason: (reason) => { stopReason = reason; },
      onClaudeAssistantContent: (blocks) => { replyContent = cloneReplayState(blocks); },
      onClaudeUsage: (usage, responseId) => logClaudeUsage(debug, config, usage, responseId),
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onToolCall: (toolCall) => {
        diagnostics.onToolCall();
        parseToolArguments(toolCall.function.arguments);
        replayBudget.reserveJson(toolCall); pendingTools.push(cloneReplayState(toolCall));
      },
    }, token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (hasThinking && !replyContent) throw new vscode.LanguageModelError('The Relay did not return complete signed thinking blocks. Native thinking cannot be replayed safely.');
    const blocks: readonly ClaudeContentBlock[] = replyContent ?? [
      ...(replyText ? [{ type: 'text' as const, text: replyText }] : []),
      ...pendingTools.map((call) => ({ type: 'tool_use' as const, id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments) })),
    ];
    const complete = stopReason !== 'max_tokens' && stopReason !== 'pause_turn' && stopReason !== 'model_context_window_exceeded';
    const savedBlocks = complete ? blocks : blocks.filter((block) => block.type === 'text');
    replyText = reconcileProtocolText(output, replyText, savedBlocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
    const calls: ToolCall[] = (complete ? blocks : []).flatMap((block) => block.type === 'tool_use' ? [{
      id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) },
    }] : []);
    const parts = prepareProtocolTools(calls);
    if (replayAvailable) reportProtocolReplay(output, { version: 1, identity: context.protocolIdentity, apiType: 'messages', displayText: replyText, claude: savedBlocks, claudePrefix: signedPrefix });
    for (const part of parts) { if (token.isCancellationRequested) throw new vscode.CancellationError(); output.report(part); }
    output.flush();
    diagnostics.complete();
  } catch (error) {
    if (token.isCancellationRequested) {
      output.discard();
      diagnostics.cancelled();
      throw new vscode.CancellationError();
    }
    try { output.flush(); } catch { /* Preserve the stream failure. */ }
    diagnostics.failed(error);
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
  );
}
