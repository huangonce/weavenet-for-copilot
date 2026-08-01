/**
 * HTTP header ownership rules shared by the relay protocol layer.
 * These headers are controlled by the extension and can never be
 * overridden per connection, so the relay layer filters them out of
 * user-supplied request headers before they reach the wire.
 */

const RESERVED_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-version',
  'authorization',
  'cookie',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
]);

/** Headers owned by the extension and never configurable per connection. */
export function isReservedRelayHeader(name: string): boolean {
  return RESERVED_REQUEST_HEADERS.has(name.trim().toLowerCase());
}
