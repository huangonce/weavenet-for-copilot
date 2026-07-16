/**
 * Validates a Relay base URL and returns its canonical form. Query strings,
 * fragments and URL credentials are intentionally unsupported: they can leak
 * secrets into diagnostics or produce ambiguous endpoint requests.
 */
export function normalizeRelayBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Builds a Relay endpoint without allowing a base URL path to be discarded. */
export function relayEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalized = normalizeRelayBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error('Relay Base URL must be a valid http(s) URL without credentials, query parameters, or fragments.');
  }
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  return url.toString();
}