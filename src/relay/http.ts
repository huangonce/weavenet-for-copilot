import type { CancellationToken } from 'vscode';
import { createRelayRequestError, RelayRequestError } from './errors';

export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MAX_COMPLETE_RESPONSE_BYTES = 10 * 1024 * 1024;

export class RelayTimeoutError extends Error {
  constructor(readonly phase: 'response' | 'stream', readonly timeoutMs: number) {
    super(`Relay ${phase} timed out after ${timeoutMs}ms.`);
    this.name = 'RelayTimeoutError';
  }
}

export interface AbortContext {
  readonly signal: AbortSignal;
  dispose(): void;
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

export interface SseChunkResult {
  readonly buffer: string;
  readonly stopped: boolean;
}

const SSE_DECODE_SLICE_BYTES = 64 * 1024;

export function consumeSseChunk(
  value: Uint8Array | undefined,
  decoder: TextDecoder,
  initialBuffer: string,
  maxEventBytes: number,
  onLine: (line: string) => boolean,
  oversizedError: () => Error,
): SseChunkResult {
  let buffer = initialBuffer;
  const consumeDecoded = (decoded: string): boolean => {
    buffer += decoded;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxEventBytes) throw oversizedError();
      if (onLine(line)) return true;
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer) > maxEventBytes) throw oversizedError();
    return false;
  };

  if (!value) {
    return { buffer, stopped: consumeDecoded(decoder.decode()) };
  }
  for (let offset = 0; offset < value.byteLength; offset += SSE_DECODE_SLICE_BYTES) {
    const slice = value.subarray(offset, Math.min(offset + SSE_DECODE_SLICE_BYTES, value.byteLength));
    if (consumeDecoded(decoder.decode(slice, { stream: true }))) return { buffer, stopped: true };
  }
  return { buffer, stopped: false };
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
      response.headers.get('x-request-id') ?? undefined,
    ),
  };
}

export function createAbortContext(token?: CancellationToken, timeoutMs?: number): AbortContext {
  const controller = new AbortController();
  if (token?.isCancellationRequested) {
    controller.abort();
  }
  const cancellation = token?.onCancellationRequested(() => controller.abort());
  let timedOut = false;
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new RelayTimeoutError('response', timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      cancellation?.dispose();
      if (timeout) clearTimeout(timeout);
      if (timedOut && !controller.signal.reason) {
        controller.abort(new RelayTimeoutError('response', timeoutMs!));
      }
    },
  };
}

export async function fetchWithResponseTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  token?: CancellationToken,
): Promise<Response> {
  const context = createAbortContext(token, timeoutMs);
  try {
    // Relay requests may contain API keys and connection-scoped headers.
    // Refuse redirects instead of risking forwarding them to another origin.
    return await fetch(url, { ...init, redirect: 'error', signal: context.signal });
  } catch (error) {
    if (context.signal.reason instanceof RelayTimeoutError) throw context.signal.reason;
    throw error;
  } finally {
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
        response.headers.get('x-request-id') ?? undefined,
      );
    }
    return {
      value: JSON.parse(body) as T,
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'unknown',
      requestId: response.headers.get('x-request-id') ?? undefined,
    };
  } catch (error) {
    if (context.signal.reason instanceof RelayTimeoutError) throw context.signal.reason;
    throw error;
  } finally {
    context.dispose();
  }
}

async function readResponseTextWithSignal(response: Response, signal: AbortSignal, maxBodyBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await readWithAbortSignal(reader, signal);
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

function byteLength(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value));
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

export async function readResponseText(
  response: Response,
  idleTimeoutMs: number,
  token?: CancellationToken,
  maxBodyBytes = MAX_COMPLETE_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, token);
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
  return !(error instanceof Error && error.name === 'AbortError') &&
    !(error instanceof RelayRequestError && error.status >= 400 && error.status < 500);
}