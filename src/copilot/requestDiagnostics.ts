import type { ExtensionConfig } from '../config/config';
import { RelayRequestError, RelayStreamError } from '../relay/errors';
import { RelayTimeoutError } from '../relay/http';
import { InvalidToolArgumentsError } from './helpers';
import type { ResponseDiagnosticsMetadata } from '../relay/types';

export interface RequestDiagnostics {
  onContent(): void;
  onReasoning(): void;
  onToolCall(): void;
  onRefusal(): void;
  onOpenAIFinishReason(reason: string): void;
  onResponse(protocol: 'OpenAI' | 'Claude', status: number, contentType: string, metadata?: ResponseDiagnosticsMetadata): void;
  onStreamEnd(protocol: 'OpenAI' | 'Claude', terminalEvent: '[DONE]' | 'finish_reason' | 'message_stop'): void;
  complete(): void;
  cancelled(): void;
  failed(error: unknown): void;
}

export type DebugLogger = (config: ExtensionConfig, message: string) => void;

export function createRequestDiagnostics(
  debug: DebugLogger,
  config: ExtensionConfig,
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
  let refusals = 0;
  let responseStatus: number | undefined;
  let responseContentType: string | undefined;
  let terminalEvent: string | undefined;
  let finishReason: string | undefined;
  let responseMetadata: ResponseDiagnosticsMetadata | undefined;

  const elapsed = (): number => Date.now() - startedAt;
  const summary = (): string =>
    `protocol=${protocol} model=${model} messages=${messageCount} tools=${toolCount} `
      + `http=${responseStatus ?? 'n/a'} contentType=${responseContentType ?? 'n/a'} `
      + `ttfbMs=${firstOutputAt === undefined ? 'n/a' : firstOutputAt - startedAt} elapsedMs=${elapsed()} `
      + `parts={content:${contentParts},reasoning:${reasoningParts},tools:${toolCalls},refusals:${refusals}}`
      + (terminalEvent ? ` terminal=${terminalEvent}` : '')
      + (finishReason ? ` finishReason=${safeDiagnosticValue(finishReason)}` : '')
      + formatResponseMetadata(responseMetadata);
  const markFirstOutput = (): void => {
    firstOutputAt ??= Date.now();
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
    onOpenAIFinishReason: (reason) => {
      finishReason = reason;
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
    complete: () => debug(config, `${protocol} request completed: ${summary()}`),
    cancelled: () => debug(config, `${protocol} request cancelled: ${summary()}`),
    failed: (error) => debug(config, `${protocol} request failed: ${summary()} error=${formatLogError(error)}`),
  };
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
