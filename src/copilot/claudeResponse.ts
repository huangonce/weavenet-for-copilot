import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import { RelayClient } from '../relay/client';
import { isClaudeTruncated } from '../relay/claude';
import { supportsImageInputForRoutedModel, supportsToolCallingForModel } from '../relay/models';
import type { ClaudeRequest, RoutedModel } from '../relay/types';
import { convertClaudeMessages, convertClaudeTools } from './convert';
import { claudePrefix, validateClaudePrefixes } from './claudePrefix';
import {
  clampClaudeTemperature,
  getConfiguredReasoningEffort,
  toClaudeThinking,
} from './helpers';
import type { DebugLogger } from './requestDiagnostics';
import type { CanonicalChatRequestSnapshot, CanonicalChatResponseOptions } from './canonicalRequest';
import { cloneReplayState, ReplayBudget, replayDisplayText } from '../relay/replayState';
import type { ProtocolReplayState } from '../relay/replayState';
import { hasProtocolReplayCarrier, prepareProtocolTools, reconcileProtocolText, reportProtocolReplay, warnProtocolReplayUnavailable } from './protocolState';
import type { ClaudeContentBlock, ToolCall } from '../relay/types';
import { runResponseLifecycle } from './responseLifecycle';

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
  const { config, routedModel, model, messages, options, token, apiKey, debug } = context;
  // Without the host carrier no signed thinking block can survive a turn, so
  // native thinking is disabled for the request instead of failing it.
  const replayAvailable = hasProtocolReplayCarrier();
  if (!replayAvailable) warnProtocolReplayUnavailable('Claude');
  const caching = config.claudePromptCaching !== 'disabled';
  const automaticCaching = caching && routedModel.claude?.automaticCaching === true;
  const explicitCaching = caching && !automaticCaching;
  const tools = supportsToolCallingForModel(routedModel, config)
    ? convertClaudeTools(options.tools, explicitCaching, config.claudePromptCachingTTL)
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
    promptCaching: explicitCaching, cacheTTL: config.claudePromptCachingTTL,
    protocolIdentity: context.protocolIdentity, requiresThinkingState: !!thinking,
  });
  const request: ClaudeRequest = {
    model: routedModel.upstreamId,
    max_tokens: model.maxOutputTokens ?? config.maxOutputTokens,
    messages: converted.messages,
    // Keep one system block shape in every cache mode so enabling, disabling or
    // moving cache controls does not change the signed conversation prefix hash.
    system: typeof converted.system === 'string'
      ? [{ type: 'text', text: converted.system }] : converted.system,
    stream: true,
    ...(automaticCaching ? { cache_control: { type: 'ephemeral' as const,
      ...(config.claudePromptCachingTTL === '1h' ? { ttl: '1h' as const } : {}) } } : {}),
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
  const replayBudget = new ReplayBudget();
  let replyText = '';
  let stopReason: string | undefined;
  let replyContent: readonly ClaudeContentBlock[] | undefined;
  const client = new RelayClient({
    baseUrl: config.baseUrl,
    apiKey,
    requestHeaders: config.requestHeaders,
    authScheme: 'x-api-key',
    anthropicVersion: config.anthropicVersion,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });

  await runResponseLifecycle(context, 'Claude', request.messages.length, request.tools?.length ?? 0, async (output, diagnostics) => {
    await client.streamClaudeMessages(request, {
      onContent: (text) => {
        diagnostics.onContent();
        replayBudget.reserve(text); replyText += text;
        output.text(text);
      },
      onReasoning: (text) => {
        diagnostics.onReasoning();
        replayBudget.reserve(text);
        output.thinking(text);
      },
      onClaudeStopReason: (reason) => { stopReason = reason; },
      onClaudeAssistantContent: (blocks) => { replyContent = cloneReplayState(blocks); },
      onClaudeUsage: diagnostics.onClaudeUsage,
      onRequest: diagnostics.onRequest,
      onRequestSettled: diagnostics.onRequestSettled,
      onResponse: diagnostics.onResponse,
      onStreamEnd: diagnostics.onStreamEnd,
      onToolCall: diagnostics.onToolCall,
    }, token);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (!replyContent) throw new Error('Claude completed without its protocol replay payload.');
    const complete = !isClaudeTruncated(stopReason);
    const savedBlocks = complete ? replyContent : replyContent.filter((block) => block.type === 'text');
    const replay: ProtocolReplayState = { version: 1, identity: context.protocolIdentity, apiType: 'messages', displayText: replyText, claude: savedBlocks, claudePrefix: signedPrefix };
    replyText = reconcileProtocolText(output, replyText, replayDisplayText(replay));
    const calls: ToolCall[] = (stopReason === 'tool_use' ? replyContent : []).flatMap((block) => block.type === 'tool_use' ? [{
      id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) },
    }] : []);
    const parts = prepareProtocolTools(calls);
    if (replayAvailable) reportProtocolReplay(output, { ...replay, displayText: replyText });
    for (const part of parts) { if (token.isCancellationRequested) throw new vscode.CancellationError(); output.report(part); }
  });
}

function logClaudeRequest(debug: DebugLogger, config: ExtensionConfig, request: ClaudeRequest): void {
  if (!config.debug) return;
  const cacheMode = request.cache_control ? 'automatic' : config.claudePromptCaching === 'disabled' ? 'disabled' : 'explicit';
  const systemChars = typeof request.system === 'string'
    ? request.system.length
    : request.system?.reduce((total, block) => total + block.text.length, 0) ?? 0;
  debug(
    config,
    `Claude Messages request: model=${request.model}, cacheMode=${cacheMode}, `
      + `messages=${request.messages.length}, tools=${request.tools?.length ?? 0}, systemChars=${systemChars}`,
  );
}
