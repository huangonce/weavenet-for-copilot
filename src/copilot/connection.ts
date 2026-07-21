import * as vscode from 'vscode';
import { RelayRequestError, RelayStreamError } from '../relay/errors';
import { RelayTimeoutError } from '../relay/http';

export interface ConnectionTestFailure {
  readonly category: 'url' | 'network' | 'timeout' | 'authentication' | 'notFound' | 'rateLimited' | 'server' | 'http' | 'invalidResponse' | 'protocol' | 'cancelled' | 'unknown';
  readonly message: string;
  readonly status?: number;
  readonly responseType?: RelayRequestError['responseKind'];
  readonly requestId?: string;
}

export function safeHost(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.host || undefined : undefined;
  } catch {
    return undefined;
  }
}

export function safeEndpoint(baseUrl: string, path: string): string {
  try {
    const url = new URL(baseUrl);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    return url.toString();
  } catch {
    return path;
  }
}

export class ConnectionTestError extends Error {
  constructor(readonly failure: ConnectionTestFailure) {
    super(failure.message);
    this.name = 'ConnectionTestError';
  }
}

export function describeConnectionTestError(error: unknown): ConnectionTestFailure {
  if (error instanceof ConnectionTestError) return error.failure;
  if (error instanceof RelayRequestError) {
    const common = { status: error.status, responseType: error.responseKind, requestId: error.requestId };
    if (error.status === 401 || error.status === 403) return { ...common, category: 'authentication', message: 'API key was rejected or lacks permission.' };
    if (error.status === 404) return { ...common, category: 'notFound', message: 'The Relay does not expose a compatible endpoint at this path.' };
    if (error.status === 429) return { ...common, category: 'rateLimited', message: 'The Relay is rate-limiting requests. Try again later.' };
    if (error.status >= 500) return { ...common, category: 'server', message: 'The Relay or its upstream returned a server error.' };
    return { ...common, category: 'http', message: `The Relay returned HTTP ${error.status}.` };
  }
  if (error instanceof RelayTimeoutError) return { category: 'timeout', message: 'The Relay timed out before completing the request.' };
  if (error instanceof RelayStreamError) return {
    category: 'protocol',
    message: 'The Relay response did not complete the expected protocol.',
    requestId: error.requestId,
  };
  if (error instanceof SyntaxError || (error instanceof Error && /invalid|malformed|empty response body|exceeds \d+ bytes/iu.test(error.message))) {
    return { category: 'invalidResponse', message: 'The Relay returned an invalid or excessive response.' };
  }
  if (error instanceof vscode.CancellationError || (error instanceof Error && (error.name === 'CancellationError' || error.name === 'AbortError'))) {
    return { category: 'cancelled', message: 'The connection test was cancelled; the Relay may already have processed the request.' };
  }
  if (error instanceof TypeError) return { category: 'network', message: 'Could not reach the Relay. Check the URL, DNS, TLS certificate, proxy, and network connection.' };
  return { category: 'unknown', message: 'The Relay connection could not be completed.' };
}

export function connectionErrorMessage(error: unknown): string {
  if (error instanceof RelayRequestError) {
    if (error.status === 401 || error.status === 403) return 'Authentication was rejected by the Relay.';
    if (error.status === 404) return 'The Relay does not expose a compatible /models endpoint.';
    if (error.status === 429) return 'The Relay is rate-limiting requests.';
    if (error.status >= 500) return 'The Relay or its upstream returned a server error.';
    return `The Relay returned HTTP ${error.status}.`;
  }
  return 'The Relay connection could not be completed.';
}

export function toLanguageModelError(error: unknown): Error {
  if (error instanceof vscode.LanguageModelError || error instanceof vscode.CancellationError) return error;
  if (error instanceof RelayRequestError) {
    const suffix = [error.upstreamCode, error.requestId].filter(Boolean).join('/');
    const message = suffix ? `${error.message} [${suffix}]` : error.message;
    if (error.status === 401) return vscode.LanguageModelError.NoPermissions(message);
    if (error.status === 404) return vscode.LanguageModelError.NotFound(message);
    if (error.status === 403 || error.status === 429 || isQuotaError(error.upstreamCode, error.upstreamType, message)) {
      return vscode.LanguageModelError.Blocked(message);
    }
    return new vscode.LanguageModelError(message, { cause: error });
  }
  if (error instanceof RelayStreamError) {
    if (error.rateLimited || isQuotaError(error.upstreamCode, error.upstreamType, error.message)) {
      return vscode.LanguageModelError.Blocked(error.message);
    }
    return new vscode.LanguageModelError(error.message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isQuotaError(...values: Array<string | undefined>): boolean {
  return /rate.?limit|quota|insufficient.?credit|billing|payment.?required/i.test(values.filter(Boolean).join(' '));
}
