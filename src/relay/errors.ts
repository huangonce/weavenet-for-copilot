export class RelayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseKind: 'json' | 'sse' | 'html' | 'text' | 'empty',
    readonly upstreamCode?: string,
    readonly upstreamType?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'RelayRequestError';
  }
}

export class RelayStreamError extends Error {
  constructor(
    message: string,
    readonly protocol: 'OpenAI' | 'Claude',
  ) {
    super(message);
    this.name = 'RelayStreamError';
  }
}

export function createRelayRequestError(
  status: number,
  statusText: string,
  contentType: string,
  body: string,
): RelayRequestError {
  const responseKind = classifyResponse(contentType, body);
  const upstreamMessage = extractUpstreamMessage(body, responseKind);
  const detail = extractUpstreamDetail(body, responseKind);

  if (upstreamMessage && isContextWindowError(upstreamMessage)) {
    return new RelayRequestError(
      "The request exceeds this model's context window. Start a new chat or reduce attached files and workspace context.",
      status,
      responseKind,
      detail.code,
      detail.type,
      detail.requestId,
    );
  }

  const statusLabel = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  if (responseKind === 'html') {
    const hint = status === 502
      ? ' The upstream connection failed. If this occurred at the end of a long conversation, start a new chat or reduce attached context.'
      : '';
    return new RelayRequestError(`Relay gateway returned ${statusLabel}.${hint}`, status, responseKind, detail.code, detail.type, detail.requestId);
  }

  const suffix = upstreamMessage ? ` - ${truncate(upstreamMessage, 300)}` : '';
  return new RelayRequestError(`Relay request failed: ${statusLabel}${suffix}`, status, responseKind, detail.code, detail.type, detail.requestId);
}

export function createRelayStreamError(
  protocol: RelayStreamError['protocol'],
  upstreamMessage?: string,
): RelayStreamError {
  if (upstreamMessage && isContextWindowError(upstreamMessage)) {
    return new RelayStreamError(
      "The request exceeds this model's context window. Start a new chat or reduce attached files and workspace context.",
      protocol,
    );
  }

  const detail = upstreamMessage ? ` - ${truncate(upstreamMessage, 300)}` : '';
  return new RelayStreamError(`Relay ${protocol} stream failed${detail}`, protocol);
}

export function createIncompleteStreamError(
  protocol: RelayStreamError['protocol'],
  reason: 'missing-terminal-event' | 'empty-response' | 'missing-terminal-empty-response',
): RelayStreamError {
  const message = reason === 'empty-response'
    ? `Relay ${protocol} stream completed without any text, reasoning, or tool calls.`
    : reason === 'missing-terminal-empty-response'
      ? `Relay ${protocol} stream ended without a response or terminal event.`
      : `Relay ${protocol} stream ended before its terminal event was received.`;
  return new RelayStreamError(message, protocol);
}

function classifyResponse(
  contentType: string,
  body: string,
): RelayRequestError['responseKind'] {
  const normalizedType = contentType.toLowerCase();
  const trimmed = body.trimStart();
  if (!trimmed) return 'empty';
  if (normalizedType.includes('text/html') || /^<!doctype html\b|^<html\b/i.test(trimmed)) return 'html';
  if (normalizedType.includes('text/event-stream') || /^data:\s*/m.test(trimmed)) return 'sse';
  if (normalizedType.includes('json') || /^[{[]/.test(trimmed)) return 'json';
  return 'text';
}

function extractUpstreamMessage(
  body: string,
  responseKind: RelayRequestError['responseKind'],
): string | undefined {
  if (responseKind === 'json') {
    return messageFromJson(body);
  }
  if (responseKind === 'sse') {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const message = messageFromJson(trimmed.slice('data:'.length).trim());
      if (message) return message;
    }
  }
  if (responseKind === 'text') {
    return body.trim() || undefined;
  }
  return undefined;
}

function messageFromJson(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return findMessage(parsed);
  } catch {
    return undefined;
  }
}

function extractUpstreamDetail(
  body: string,
  responseKind: RelayRequestError['responseKind'],
): { code?: string; type?: string; requestId?: string } {
  if (responseKind !== 'json' && responseKind !== 'sse') return {};
  const value = responseKind === 'sse'
    ? body.split(/\r?\n/).find((line) => line.trim().startsWith('data:'))?.trim().slice('data:'.length).trim()
    : body;
  if (!value) return {};
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    const error = payload.error && typeof payload.error === 'object'
      ? payload.error as Record<string, unknown>
      : payload;
    return {
      code: stringField(error.code),
      type: stringField(error.type),
      requestId: stringField(error.request_id) ?? stringField(payload.request_id),
    };
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(value.trim(), 100) : undefined;
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  for (const key of ['error', 'response', 'detail']) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    const message = findMessage(nested, depth + 1);
    if (message) return message;
  }
  return undefined;
}

function isContextWindowError(message: string): boolean {
  return /context window|context length|maximum context|input exceeds.*context|too many tokens/i.test(message);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}
