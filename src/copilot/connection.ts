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
    const message = relayRequestDisplayMessage(error);
    if (error.status === 401) return vscode.LanguageModelError.NoPermissions(message);
    if (error.status === 404) return vscode.LanguageModelError.NotFound(message);
    if (error.status === 402 || error.status === 403 || error.status === 429
      || isQuotaError(error.upstreamCode, error.upstreamType, error.message)) {
      return vscode.LanguageModelError.Blocked(message);
    }
    // Do not attach the transport error as `cause`: some VS Code versions
    // unwrap it and expose the upstream body and extension-host stack in Chat.
    // Request diagnostics have already recorded the safe structured details.
    return new vscode.LanguageModelError(message);
  }
  if (error instanceof RelayStreamError) {
    const message = relayStreamDisplayMessage(error);
    if (error.rateLimited || isQuotaError(error.upstreamCode, error.upstreamType, error.message)) {
      return vscode.LanguageModelError.Blocked(message);
    }
    return new vscode.LanguageModelError(message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Strips internal details from an error that will cross the extension-host RPC
 * boundary and may be rendered verbatim inside Chat.
 *
 * Two things make the user-facing message noisy:
 * - `error.stack` is captured lazily by V8 and then serialized by
 *   `transformErrorForSerialization`. VS Code surfaces (e.g. the Copilot
 *   extension) render it as `message: stack`, exposing frames like
 *   `at i.tryDeserialize (...extensionHostProcess.js...)`.
 * - When the serialized `name` is `LanguageModelError`,
 *   `LanguageModelError.tryDeserialize` rebuilds the error from
 *   `message`/`code`/`cause` and the rebuilt instance captures a fresh stack
 *   full of internal RPC frames, which we cannot control afterwards.
 *
 * Overwriting `stack` with `undefined` drops it from the serialized payload,
 * and renaming to `Error` routes deserialization through
 * `transformErrorFromSerialization`, which adopts the sanitized (undefined)
 * stack value. The error still keeps its message, code, and prototype, so
 * `instanceof` checks and `code`-based handling keep working.
 */
export function sanitizeLanguageModelError(error: unknown): unknown {
  if (error instanceof vscode.CancellationError) return error;
  if (error instanceof Error) {
    Object.defineProperty(error, 'stack', { value: undefined, configurable: true, writable: true });
    if (error instanceof vscode.LanguageModelError) {
      error.name = 'Error';
    }
  }
  return error;
}

function relayRequestDisplayMessage(error: RelayRequestError): string {
  const zh = usesSimplifiedChinese();
  if (error.message.startsWith("The request exceeds this model's context window.")) {
    return zh
      ? '请求超出此模型的上下文窗口。请新建对话，或减少附件和工作区上下文。'
      : error.message;
  }
  if (error.status === 426) {
    return zh
      ? '[426] 此接口仅支持 WebSocket，而扩展使用 HTTP 流式传输。请改用支持 HTTP Responses API 的路由组，或将模型切换到 Chat Completions。'
      : '[426] This endpoint only supports WebSocket, while the extension uses HTTP streaming. Use a route that exposes the Responses API over HTTP, or switch the model to Chat Completions.';
  }
  if (error.status === 502 && error.responseKind === 'html') {
    return zh
      ? '[502] 网关无法连接上游模型服务。如果错误发生在长对话末尾，请新建对话或减少上下文。'
      : '[502] The gateway could not reach the upstream model service. If this occurred near the end of a long conversation, start a new chat or reduce context.';
  }
  const messages: Readonly<Record<number, readonly [string, string]>> = {
    400: ['The request format is invalid. Check the model configuration or request parameters.', '请求格式无效。请检查模型配置或请求参数。'],
    401: ['Authentication failed. Check the API key for this connection.', '身份验证失败。请检查此连接的 API Key。'],
    402: ['The account has insufficient balance. Check the upstream account balance.', '账户余额不足。请检查上游账户余额。'],
    403: ['The request was denied. Check the API key permissions and model access.', '请求被拒绝。请检查 API Key 权限和模型访问权限。'],
    404: ['The endpoint or model was not found. Check the connection URL and model ID.', '未找到接口或模型。请检查连接地址和模型 ID。'],
    408: ['The service timed out while processing the request. Please try again.', '服务处理请求超时，请重试。'],
    413: ['The request is too large. Reduce attached files or conversation context.', '请求内容过大。请减少附件或会话上下文。'],
    422: ['The request contains unsupported parameters. Check the model configuration.', '请求包含不支持的参数。请检查模型配置。'],
    429: ['Too many requests. Please wait briefly and try again.', '请求过于频繁。请稍后重试。'],
    500: ['The upstream service encountered an internal error. Please try again later.', '上游服务发生内部错误。请稍后重试。'],
    502: ['The gateway could not reach the upstream model service. Please try again later.', '网关无法连接上游模型服务。请稍后重试。'],
    503: ['The model service is temporarily overloaded or unavailable. Please try again shortly.', '模型服务暂时过载或不可用。请稍后重试。'],
    504: ['The gateway timed out waiting for the upstream model service. Please try again.', '网关等待上游模型服务超时。请重试。'],
  };
  const pair = messages[error.status];
  const summary = pair ? pair[zh ? 1 : 0] : zh ? '服务返回了错误响应。' : 'The service returned an error response.';
  return `[${error.status}] ${summary}`;
}

function relayStreamDisplayMessage(error: RelayStreamError): string {
  const zh = usesSimplifiedChinese();
  if (error.message.startsWith("The request exceeds this model's context window.")) {
    return zh
      ? '请求超出此模型的上下文窗口。请新建对话，或减少附件和工作区上下文。'
      : error.message;
  }
  if (error.rateLimited || isQuotaError(error.upstreamCode, error.upstreamType, error.message)) {
    return zh ? '请求受到速率或额度限制。请稍后重试或检查账户额度。' : 'The request was rate- or quota-limited. Please try again later or check the account quota.';
  }
  return zh
    ? '模型响应流意外中断。请重试；如果问题持续，请检查服务状态。'
    : 'The model response stream ended unexpectedly. Please try again; if the problem persists, check the service status.';
}

function usesSimplifiedChinese(): boolean {
  return /^(zh-cn|zh-hans)(?:$|-)/i.test(vscode.env.language);
}

function isQuotaError(...values: Array<string | undefined>): boolean {
  return /rate.?limit|quota|insufficient.?credit|billing|payment.?required/i.test(values.filter(Boolean).join(' '));
}
