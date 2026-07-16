import type { ExtensionConfig } from '../config/config';
import { RelayRequestError, RelayStreamError } from '../relay/errors';
import { RelayTimeoutError } from '../relay/http';

export interface RequestDiagnostics {
  onContent(): void;
  onReasoning(): void;
  onToolCall(): void;
  onResponse(protocol: 'OpenAI' | 'Claude', status: number, contentType: string): void;
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
    onResponse: (_responseProtocol, status, contentType) => {
      responseStatus = status;
      responseContentType = contentType;
      debug(config, `${protocol} response: status=${status}, contentType=${contentType}, responseMs=${elapsed()}`);
    },
    onStreamEnd: (_responseProtocol, event) => {
      terminalEvent = event;
    },
    complete: () => debug(config, `${protocol} request completed: ${summary()}`),
    cancelled: () => debug(config, `${protocol} request cancelled: ${summary()}`),
    failed: (error) => debug(config, `${protocol} request failed: ${summary()} error=${formatLogError(error)}`),
  };
}

export function formatLogError(error: unknown): string {
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
