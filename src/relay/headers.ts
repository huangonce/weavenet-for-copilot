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

/**
 * Returns the effective user-configured headers in deterministic wire form.
 * `Headers.set` supplies the same validation, whitespace normalization and
 * case-insensitive last-write-wins behavior used by {@link RelayClient}.
 */
export function canonicalRelayHeaders(
  requestHeaders: Readonly<Record<string, string>>,
): Array<readonly [name: string, value: string]> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (isReservedRelayHeader(name)) continue;
    try {
      headers.set(name, value);
    } catch {
      // Ignore malformed settings exactly as the request layer does.
    }
  }
  return [...headers.entries()]
    .map(([name, value]) => [name, value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}
