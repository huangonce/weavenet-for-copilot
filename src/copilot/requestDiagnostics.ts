import type { ExtensionConfig } from '../config/config';
import { RelayRequestError, RelayResponseParseError, RelayStreamError } from '../relay/errors';
import { RelayTimeoutError } from '../relay/http';
import { InvalidToolArgumentsError } from './helpers';
import type {
  ClaudeUsage,
  OpenAIUsage,
  RelayProtocol,
  RequestDiagnosticsMetadata,
  RequestTransportDiagnosticsMetadata,
  ResponseDiagnosticsMetadata,
} from '../relay/types';

export interface RequestDiagnostics {
  onContent(): void;
  onReasoning(): void;
  onToolCall(): void;
  onRefusal(): void;
  onRequest(protocol: RelayProtocol, metadata: RequestDiagnosticsMetadata): void;
  onRequestSettled(protocol: RelayProtocol, metadata: RequestTransportDiagnosticsMetadata): void;
  onOpenAIFinishReason(reason: string): void;
  onOpenAIUsage(usage: OpenAIUsage): void;
  onClaudeUsage(usage: ClaudeUsage, responseId?: string): void;
  onResponse(protocol: RelayProtocol, status: number, contentType: string, metadata?: ResponseDiagnosticsMetadata): void;
  onStreamEnd(protocol: RelayProtocol, terminalEvent: '[DONE]' | 'finish_reason' | 'message_stop' | 'completed' | 'incomplete'): void;
  complete(): void;
  cancelled(): void;
  failed(error: unknown): void;
}

export type DebugLogger = (config: ExtensionConfig, message: string) => void;

type UsageField = 'inputTotal' | 'inputUncached' | 'output' | 'total' | 'cacheRead' | 'cacheWrite'
  | 'cacheWrite5m' | 'cacheWrite1h' | 'reasoning' | 'predictionAccepted' | 'predictionRejected';
type UsageCounts = Partial<Record<UsageField, number>>;

export function createRequestDiagnostics(
  debug: DebugLogger,
  config: ExtensionConfig,
  protocol: RelayProtocol,
  model: string,
  messageCount: number,
  toolCount: number,
): RequestDiagnostics {
  const startedAt = Date.now();
  let firstOutputAt: number | undefined;
  let contentParts = 0;
  let reasoningParts = 0;
  let toolCalls = 0;
  let refusals = 0;
  let responseStatus: number | undefined;
  let responseContentType: string | undefined;
  let terminalEvent: string | undefined;
  let finishReason: string | undefined;
  let responseMetadata: ResponseDiagnosticsMetadata | undefined;
  let requestMetadata: RequestDiagnosticsMetadata | undefined;
  let transportMetadata: RequestTransportDiagnosticsMetadata | undefined;
  const usage: UsageCounts = {};
  let usageResponseId: string | undefined;
  let settled = false;

  const elapsed = (): number => Date.now() - startedAt;
  const summary = (): string =>
    `protocol=${protocol} model=${model} messages=${messageCount} tools=${toolCount} `
      + `http=${responseStatus ?? 'n/a'} contentType=${responseContentType ?? 'n/a'} `
      + `ttfbMs=${firstOutputAt === undefined ? 'n/a' : firstOutputAt - startedAt} elapsedMs=${elapsed()} `
      + `parts={content:${contentParts},reasoning:${reasoningParts},tools:${toolCalls},refusals:${refusals}}`
      + (terminalEvent ? ` terminal=${terminalEvent}` : '')
      + (finishReason ? ` finishReason=${safeDiagnosticValue(finishReason)}` : '')
      + formatRequestMetadata(requestMetadata)
      + formatTransportMetadata(transportMetadata)
      + formatResponseMetadata(responseMetadata)
      + formatUsage(protocol, usage)
      + (usageResponseId ? ` usageResponseId=${safeDiagnosticValue(usageResponseId)}` : '');
  const markFirstOutput = (): void => {
    firstOutputAt ??= Date.now();
  };
  const recordUsage = (update: UsageCounts): void => {
    if (settled) return;
    for (const field of Object.keys(update) as UsageField[]) {
      const value = update[field];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[field] = value;
    }
  };
  const settle = (outcome: 'completed' | 'cancelled' | 'failed', details = ''): void => {
    if (settled) return;
    settled = true;
    debug(config, `${protocol} request ${outcome}: ${summary()}${details}`);
  };

  debug(config, `${protocol} request started: model=${model}, messages=${messageCount}, tools=${toolCount}`);
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
    onRefusal: () => {
      markFirstOutput();
      refusals++;
    },
    onRequest: (_requestProtocol, metadata) => {
      requestMetadata = metadata;
      debug(config, `${protocol} transport started:${formatRequestMetadata(metadata)}`);
    },
    onRequestSettled: (_requestProtocol, metadata) => {
      transportMetadata = metadata;
      debug(config, `${protocol} transport settled: elapsedMs=${elapsed()}${formatTransportMetadata(metadata)}`);
    },
    onOpenAIFinishReason: (reason) => {
      finishReason = reason;
    },
    onOpenAIUsage: (value) => recordUsage({
      inputTotal: value.prompt_tokens,
      output: value.completion_tokens,
      total: value.total_tokens,
      cacheRead: value.prompt_tokens_details?.cached_tokens,
      cacheWrite: value.prompt_tokens_details?.cache_write_tokens,
      reasoning: value.completion_tokens_details?.reasoning_tokens,
      predictionAccepted: value.completion_tokens_details?.accepted_prediction_tokens,
      predictionRejected: value.completion_tokens_details?.rejected_prediction_tokens,
    }),
    onClaudeUsage: (value, responseId) => {
      // message_delta usage is cumulative. Replace supplied fields and retain
      // earlier fields omitted by a later event; never add successive counts.
      recordUsage({
        inputUncached: value.input_tokens,
        output: value.output_tokens,
        cacheRead: value.cache_read_input_tokens,
        cacheWrite: value.cache_creation_input_tokens,
        cacheWrite5m: value.cache_creation?.ephemeral_5m_input_tokens,
        cacheWrite1h: value.cache_creation?.ephemeral_1h_input_tokens,
      });
      if (!settled && typeof responseId === 'string' && responseId) usageResponseId = responseId;
    },
    onResponse: (_responseProtocol, status, contentType, metadata) => {
      responseStatus = status;
      responseContentType = contentType;
      responseMetadata = metadata;
      debug(config, `${protocol} response: status=${status}, contentType=${contentType}, responseMs=${elapsed()}${formatResponseMetadata(metadata)}`);
    },
    onStreamEnd: (_responseProtocol, event) => {
      terminalEvent = event;
    },
    complete: () => settle('completed'),
    cancelled: () => settle('cancelled', ' cancellationSource=vscode tokenCancellationRequested=true'),
    failed: (error) => settle('failed', ` error=${formatLogError(error)}`),
  };
}

function formatUsage(protocol: RelayProtocol, usage: UsageCounts): string {
  const inputTotal = protocol === 'Claude'
    ? sumKnownCounts(usage.inputUncached, usage.cacheRead, usage.cacheWrite)
    : usage.inputTotal;
  const total = usage.total ?? sumKnownCounts(inputTotal, usage.output);
  const values: UsageCounts = { inputTotal, output: usage.output, total,
    cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    ...(protocol === 'Claude' ? {
      inputUncached: usage.inputUncached, cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h,
    } : {
      reasoning: usage.reasoning, predictionAccepted: usage.predictionAccepted, predictionRejected: usage.predictionRejected,
    }),
  };
  return ` usage={${Object.entries(values).map(([name, value]) => `${name}:${value ?? 'n/a'}`).join(',')}}`;
}

function sumKnownCounts(...values: Array<number | undefined>): number | undefined {
  if (values.some(value => value === undefined)) return undefined;
  const sum = values.reduce<number>((total, value) => total + value!, 0);
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function formatRequestMetadata(metadata: RequestDiagnosticsMetadata | undefined): string {
  if (!metadata) return '';
  return ` clientRequestId=${safeDiagnosticValue(metadata.clientRequestId)}`
    + ` bodyBytes=${metadata.bodyBytes} clientRequestIdSent=${metadata.clientRequestIdSent}`
    + ` attempt=${metadata.attempt} stream=${metadata.stream}`;
}

function formatTransportMetadata(metadata: RequestTransportDiagnosticsMetadata | undefined): string {
  if (!metadata) return '';
  return ` clientRequestId=${safeDiagnosticValue(metadata.clientRequestId)}`
    + ` responseReceived=${metadata.responseReceived} signalAborted=${metadata.signalAborted}`
    + ` abortSource=${metadata.abortSource} tokenCancellationRequested=${metadata.tokenCancellationRequested}`;
}

function formatResponseMetadata(metadata: ResponseDiagnosticsMetadata | undefined): string {
  if (!metadata) return '';
  const values = [
    metadata.requestId ? `requestId=${safeDiagnosticValue(metadata.requestId)}` : undefined,
    metadata.clientRequestId ? `clientRequestId=${safeDiagnosticValue(metadata.clientRequestId)}` : undefined,
    metadata.processingMs !== undefined ? `processingMs=${metadata.processingMs}` : undefined,
    metadata.rateLimitRemainingRequests ? `rateRemainingRequests=${safeDiagnosticValue(metadata.rateLimitRemainingRequests)}` : undefined,
    metadata.rateLimitResetRequests ? `rateResetRequests=${safeDiagnosticValue(metadata.rateLimitResetRequests)}` : undefined,
    metadata.rateLimitRemainingTokens ? `rateRemainingTokens=${safeDiagnosticValue(metadata.rateLimitRemainingTokens)}` : undefined,
    metadata.rateLimitResetTokens ? `rateResetTokens=${safeDiagnosticValue(metadata.rateLimitResetTokens)}` : undefined,
    metadata.retryAfter ? `retryAfter=${safeDiagnosticValue(metadata.retryAfter)}` : undefined,
  ].filter(Boolean);
  return values.length ? ` ${values.join(' ')}` : '';
}

function safeDiagnosticValue(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/gu, '').trim();
  return (printable || 'unknown').slice(0, 100).replace(/\s+/gu, '_');
}

export function formatLogError(error: unknown): string {
  if (error instanceof InvalidToolArgumentsError) {
    return `InvalidToolArgumentsError(reason=${error.reason}, length=${error.argumentLength})`;
  }
  if (error instanceof RelayResponseParseError) {
    const details = [`status=${error.status}`, `responseKind=${error.responseKind}`,
      error.endpointPath ? `endpoint=${error.endpointPath}` : undefined,
      error.requestId ? `requestId=${safeDiagnosticValue(error.requestId)}` : undefined,
    ].filter(Boolean).join(', ');
    return `RelayResponseParseError(${details})`;
  }
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
  if (error instanceof RelayTimeoutError) return `RelayTimeoutError(phase=${error.phase}, timeoutMs=${error.timeoutMs})`;
  if (error instanceof TypeError) return `NetworkError(${formatSafeErrorDetails(error)})`;
  return error instanceof Error ? safeDiagnosticValue(error.name) : 'UnknownError';
}

function formatSafeErrorDetails(error: Error): string {
  const record = error as Error & { code?: unknown; cause?: unknown };
  const cause = record.cause instanceof Error || (record.cause && typeof record.cause === 'object')
    ? record.cause as { name?: unknown; code?: unknown }
    : undefined;
  return [
    `name=${safeErrorIdentifier(error.name)}`,
    typeof record.code === 'string' ? `code=${safeErrorIdentifier(record.code)}` : undefined,
    typeof cause?.name === 'string' ? `causeName=${safeErrorIdentifier(cause.name)}` : undefined,
    typeof cause?.code === 'string' ? `causeCode=${safeErrorIdentifier(cause.code)}` : undefined,
  ].filter(Boolean).join(', ');
}

function safeErrorIdentifier(value: string): string {
  const identifier = value.replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 100);
  return identifier || 'Unknown';
}
