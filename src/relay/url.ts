/**
 * Validates a Relay base URL and returns its canonical form. Remote relays
 * require TLS; plain HTTP is limited to explicit loopback hosts for local
 * development. Query strings, fragments and URL credentials are unsupported:
 * they can leak secrets into diagnostics or produce ambiguous requests.
 */
export function normalizeRelayBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname)))
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

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

/** Builds a Relay endpoint without allowing a base URL path to be discarded. */
export function relayEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalized = normalizeRelayBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error('Relay Base URL must use HTTPS, or HTTP on a loopback host, without credentials, query parameters, or fragments.');
  }
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  return url.toString();
}
