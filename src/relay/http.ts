import type { CancellationToken } from 'vscode';
import type { RelayProtocol, ResponseDiagnosticsMetadata } from './types';
import { createRelayRequestError, createRelayResponseParseError, createRelayStreamError, RelayRequestError, RelayResponseParseError } from './errors';

export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MAX_COMPLETE_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 1024 * 1024;

export class RelayTimeoutError extends Error {
  constructor(readonly phase: 'response' | 'stream', readonly timeoutMs: number) {
    super(`Relay ${phase} timed out after ${timeoutMs}ms.`);
    this.name = 'RelayTimeoutError';
  }
}

export interface AbortContext {
  readonly signal: AbortSignal;
  readonly abortSource: 'none' | 'vscode' | 'timeout';
  dispose(): void;
}

export interface FetchTransportDiagnostics {
  readonly responseReceived: boolean;
  readonly signalAborted: boolean;
  readonly abortSource: AbortContext['abortSource'];
  readonly tokenCancellationRequested: boolean;
}

export interface JsonResponse<T> {
  readonly value: T;
  readonly status: number;
  readonly contentType: string;
  readonly requestId?: string;
}

export interface RelayErrorResponse {
  readonly body: string;
  readonly error: RelayRequestError;
}

export interface SseReaderOptions {
  readonly protocol: RelayProtocol;
  readonly idleTimeoutMs: number;
  readonly token?: CancellationToken;
  readonly maxEventBytes?: number;
  /** Return true only when this protocol has received its terminal event. */
  readonly onEventData: (data: string) => boolean;
}

export interface SafeResponseMetadata {
  readonly status: number;
  readonly responseType: string;
  readonly requestId?: string;
}

const SSE_DECODE_SLICE_BYTES = 64 * 1024;
const MAX_RESPONSE_TYPE_LENGTH = 200;
const MAX_REQUEST_ID_LENGTH = 100;

export function safeResponseMetadata(response: Response): SafeResponseMetadata {
  return {
    status: response.status,
    responseType: safeHeaderValue(response.headers.get('content-type'), MAX_RESPONSE_TYPE_LENGTH) ?? 'unknown',
    requestId: responseRequestId(response),
  };
}

export function responseDiagnosticsMetadata(response: Response): ResponseDiagnosticsMetadata {
  const safe = (name: string, maximumLength = 100): string | undefined =>
    safeHeaderValue(response.headers.get(name), maximumLength);
  // Number(null) is 0, so only parse when the header actually exists;
  // relays that omit `openai-processing-ms` must not report a fake 0.
  const rawProcessingMs = response.headers.get('openai-processing-ms');
  const processing = rawProcessingMs === null ? NaN : Number(rawProcessingMs);
  return {
    requestId: responseRequestId(response),
    clientRequestId: safe('x-client-request-id'),
    processingMs: Number.isFinite(processing) && processing >= 0 ? processing : undefined,
    rateLimitLimitRequests: safe('x-ratelimit-limit-requests'),
    rateLimitRemainingRequests: safe('x-ratelimit-remaining-requests'),
    rateLimitResetRequests: safe('x-ratelimit-reset-requests'),
    rateLimitLimitTokens: safe('x-ratelimit-limit-tokens'),
    rateLimitRemainingTokens: safe('x-ratelimit-remaining-tokens'),
    rateLimitResetTokens: safe('x-ratelimit-reset-tokens'),
    retryAfter: safe('retry-after'),
  };
}

function responseRequestId(response: Response): string | undefined {
  return safeHeaderValue(response.headers.get('request-id'), MAX_REQUEST_ID_LENGTH)
    ?? safeHeaderValue(response.headers.get('x-request-id'), MAX_REQUEST_ID_LENGTH);
}

function safeHeaderValue(value: string | null, maximumLength: number): string | undefined {
  if (!value) return undefined;
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
  if (!printable) return undefined;
  return printable.length <= maximumLength ? printable : `${printable.slice(0, maximumLength - 3)}...`;
}

/**
 * Shared bounded UTF-8 transport. Protocol handlers retain their own terminal
 * and error semantics; EOF itself never dispatches an unfinished SSE event.
 */
export async function readSseStream(response: Response, options: SseReaderOptions): Promise<boolean> {
  if (!response.body) throw new Error('Relay returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseDataParser(options);
  try {
    while (true) {
      const { value, done } = await readWithIdleTimeout(reader, options.idleTimeoutMs, options.token);
      if (done) return parser.consume(decoder.decode());
      for (let offset = 0; offset < value.byteLength; offset += SSE_DECODE_SLICE_BYTES) {
        const slice = value.subarray(offset, Math.min(offset + SSE_DECODE_SLICE_BYTES, value.byteLength));
        if (parser.consume(decoder.decode(slice, { stream: true }))) return true;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * WHATWG SSE parsing: CRLF/CR/LF lines, blank-line dispatch and data folding.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
class SseDataParser {
  private line = '';
  private readonly data: string[] = [];
  private eventBytes = 0;
  private skipLineFeed = false;
  private readonly maxEventBytes: number;

  constructor(private readonly options: SseReaderOptions) {
    this.maxEventBytes = options.maxEventBytes ?? MAX_SSE_EVENT_BYTES;
  }

  consume(decoded: string): boolean {
    let start = 0;
    for (let index = 0; index < decoded.length; index++) {
      const code = decoded.charCodeAt(index);
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (code === 10) {
          if (this.eventBytes > 0) this.reserve(1);
          start = index + 1;
          continue;
        }
      }
      if (code !== 10 && code !== 13) continue;
      this.append(decoded.slice(start, index));
      this.skipLineFeed = code === 13;
      start = index + 1;
      if (this.endLine()) return true;
    }
    this.append(decoded.slice(start));
    return false;
  }

  private append(value: string): void {
    this.reserve(Buffer.byteLength(value, 'utf8'));
    this.line += value;
  }

  private reserve(bytes: number): void {
    this.eventBytes += bytes;
    if (this.eventBytes > this.maxEventBytes) {
      throw createRelayStreamError(this.options.protocol, `SSE event exceeds ${this.maxEventBytes} bytes`);
    }
  }

  private endLine(): boolean {
    const line = this.line;
    this.line = '';
    if (!line) {
      const data = this.data.length > 0 ? this.data.join('\n') : undefined;
      this.data.length = 0;
      this.eventBytes = 0;
      return data !== undefined && this.options.onEventData(data);
    }
    // Include field/comment line endings in the local event memory budget.
    this.reserve(1);
    if (line.startsWith(':')) return false;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return false;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.data.push(value);
    return false;
  }
}

export async function throwIfNotOk(
  response: Response,
  idleTimeoutMs = 60_000,
  token?: CancellationToken,
  maxBodyBytes = MAX_ERROR_RESPONSE_BYTES,
): Promise<void> {
  if (response.ok) return;

  throw (await readRelayErrorResponse(response, idleTimeoutMs, token, maxBodyBytes)).error;
}

export async function readRelayErrorResponse(
  response: Response,
  idleTimeoutMs = 60_000,
  token?: CancellationToken,
  maxBodyBytes = MAX_ERROR_RESPONSE_BYTES,
): Promise<RelayErrorResponse> {
  let body = '';
  try {
    body = await readResponseTextUpTo(response, idleTimeoutMs, token, maxBodyBytes);
  } catch (error) {
    if (isCancellationOrTimeout(error)) throw error;
  }
  return {
    body,
    error: createRelayRequestError(
      response.status,
      response.statusText,
      response.headers.get('content-type') ?? '',
      body,
      responseRequestId(response),
    ),
  };
}

export function createAbortContext(token?: CancellationToken, timeoutMs?: number): AbortContext {
  const controller = new AbortController();
  let abortSource: AbortContext['abortSource'] = 'none';
  if (token?.isCancellationRequested) {
    abortSource = 'vscode';
    controller.abort();
  }
  const cancellation = typeof token?.onCancellationRequested === 'function'
    ? token.onCancellationRequested(() => {
      if (!controller.signal.aborted) abortSource = 'vscode';
      controller.abort();
    })
    : undefined;
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = 'timeout';
    controller.abort(new RelayTimeoutError('response', timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    get abortSource() { return abortSource; },
    dispose: () => {
      cancellation?.dispose();
      if (timeout) clearTimeout(timeout);
    },
  };
}

export async function fetchWithResponseTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token?: CancellationToken,
  onSettled?: (diagnostics: FetchTransportDiagnostics) => void,
): Promise<Response> {
  const context = createAbortContext(token, timeoutMs);
  let responseReceived = false;
  try {
    // Relay requests may contain API keys and connection-scoped headers.
    // Refuse redirects instead of risking forwarding them to another origin.
    const response = await fetch(url, { ...init, redirect: 'error', signal: context.signal });
    responseReceived = true;
    return response;
  } catch (error) {
    if (context.signal.reason instanceof RelayTimeoutError) throw context.signal.reason;
    throw error;
  } finally {
    onSettled?.({
      responseReceived,
      signalAborted: context.signal.aborted,
      abortSource: context.abortSource,
      tokenCancellationRequested: token?.isCancellationRequested ?? false,
    });
    context.dispose();
  }
}

export async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token?: CancellationToken,
  maxBodyBytes = 10 * 1024 * 1024,
): Promise<T> {
  return (await fetchJsonWithRetryMetadata<T>(url, init, timeoutMs, token, maxBodyBytes)).value;
}

export async function fetchJsonWithRetryMetadata<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token?: CancellationToken,
  maxBodyBytes = 10 * 1024 * 1024,
): Promise<JsonResponse<T>> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new Error(`fetchJsonWithRetry only supports GET requests, received ${method}.`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchJsonOnce<T>(url, init, timeoutMs, token, maxBodyBytes);
    } catch (error) {
      lastError = error;
      if (token?.isCancellationRequested || attempt > 0 || !isRetryableGetError(error)) throw error;
    }
  }
  throw lastError;
}

async function fetchJsonOnce<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token?: CancellationToken,
  maxBodyBytes = 10 * 1024 * 1024,
): Promise<JsonResponse<T>> {
  const context = createAbortContext(token, timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: context.signal });
    const body = await readResponseTextWithSignal(response, context.signal, maxBodyBytes);
    if (!response.ok) {
      throw createRelayRequestError(
        response.status,
        response.statusText,
        response.headers.get('content-type') ?? '',
        body,
        responseRequestId(response),
      );
    }
    const metadata = safeResponseMetadata(response);
    let value: T;
    try {
      value = JSON.parse(body) as T;
    } catch {
      throw createRelayResponseParseError(response.status, metadata.responseType, body, url, metadata.requestId);
    }
    return {
      value,
      status: response.status,
      contentType: metadata.responseType,
      requestId: metadata.requestId,
    };
  } catch (error) {
    if (context.signal.reason instanceof RelayTimeoutError) throw context.signal.reason;
    throw error;
  } finally {
    context.dispose();
  }
}

export function readResponseTextWithSignal(response: Response, signal: AbortSignal, maxBodyBytes: number): Promise<string> {
  return readBodyText(response, maxBodyBytes, reader => readWithAbortSignal(reader, signal));
}

function byteLength(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value));
}

/** Shared bounded decoding; callers retain their total or per-read timeout policy. */
async function readBodyText(
  response: Response,
  maxBodyBytes: number,
  read: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<ReadableStreamReadResult<Uint8Array>>,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await read(reader);
      if (done) break;
      bytes += byteLength(value);
      if (bytes > maxBodyBytes) throw new Error(`Relay response body exceeds ${maxBodyBytes} bytes.`);
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readWithAbortSignal<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) throw signal.reason ?? cancellationError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? cancellationError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number,
  token?: CancellationToken,
): Promise<ReadableStreamReadResult<T>> {
  if (token?.isCancellationRequested) {
    await reader.cancel();
    throw cancellationError();
  }
  let cancellation: { dispose(): void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        cancellation = token?.onCancellationRequested(() => {
          reject(cancellationError());
          void reader.cancel();
        });
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new RelayTimeoutError('stream', timeoutMs));
          void reader.cancel().catch(() => undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    cancellation?.dispose();
  }
}

function cancellationError(): Error {
  const error = new Error('Operation cancelled.');
  error.name = 'CancellationError';
  return error;
}

export function readResponseText(
  response: Response,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxBodyBytes = MAX_COMPLETE_RESPONSE_BYTES,
): Promise<string> {
  return readBodyText(response, maxBodyBytes, reader => readWithIdleTimeout(reader, idleTimeoutMs, token));
}

async function readResponseTextUpTo(
  response: Response,
  idleTimeoutMs: number,
  token: CancellationToken | undefined,
  maxBodyBytes: number,
): Promise<string> {
  if (!response.body || maxBodyBytes <= 0) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (bytes < maxBodyBytes) {
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, token);
      if (done) return result + decoder.decode();
      const remaining = maxBodyBytes - bytes;
      const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
      const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      bytes += accepted.byteLength;
      result += decoder.decode(accepted, { stream: chunk.byteLength <= remaining });
      if (chunk.byteLength > remaining) return result + decoder.decode();
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function isCancellationOrTimeout(error: unknown): boolean {
  return error instanceof RelayTimeoutError ||
    (error instanceof Error && (error.name === 'CancellationError' || error.name === 'AbortError'));
}

function isRetryableGetError(error: unknown): boolean {
  return !(error instanceof RelayResponseParseError) &&
    !(error instanceof Error && error.name === 'AbortError') &&
    !(error instanceof RelayRequestError && error.status >= 400 && error.status < 500);
}
