import type { CancellationToken } from 'vscode';
import { createRelayRequestError } from './errors';

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

export function toAbortSignal(token: CancellationToken | undefined): AbortSignal | undefined {
  if (!token) {
    return undefined;
  }

  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}