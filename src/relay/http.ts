import type { CancellationToken } from 'vscode';
import { createRelayRequestError, RelayRequestError } from './errors';

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

export async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const text = await response.text().catch(() => '');
  throw createRelayRequestError(
    response.status,
    response.statusText,
    response.headers.get('content-type') ?? '',
    text,
  );
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
    return await fetch(url, { ...init, signal: context.signal });
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
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new Error(`fetchJsonWithRetry only supports GET requests, received ${method}.`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchWithResponseTimeout(url, init, timeoutMs, token);
      await throwIfNotOk(response);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (token?.isCancellationRequested || attempt > 0 || !isRetryableGetError(error)) throw error;
    }
  }
  throw lastError;
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
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, token);
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function isRetryableGetError(error: unknown): boolean {
  return !(error instanceof Error && error.name === 'AbortError') &&
    !(error instanceof RelayRequestError && error.status >= 400 && error.status < 500);
}