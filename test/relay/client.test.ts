import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayClient } from '../../src/relay/client';

afterEach(() => vi.restoreAllMocks());

function client(requestHeaders: Record<string, string> = {}): RelayClient {
  return new RelayClient({
    baseUrl: 'https://relay.example.test/v1',
    apiKey: 'secret-key',
    requestHeaders,
    requestTimeoutMs: 100,
    streamIdleTimeoutMs: 100,
  });
}

describe('RelayClient', () => {
  it('uses the base path, preserves allowed headers, and protects authentication headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    }));

    await client({
      'X-Tenant': 'team-a',
      Authorization: 'Bearer attacker',
      Cookie: 'session=attacker',
      'X-API-Key': 'attacker',
    }).listModels();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://relay.example.test/v1/models');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-tenant')).toBe('team-a');
    expect(headers.get('authorization')).toBe('Bearer secret-key');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('returns structured model endpoint diagnostics', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req_models' },
    }));

    await expect(client().testModels()).resolves.toEqual({
      models: { data: [{ id: 'gpt-test' }] },
      diagnostic: { endpoint: '/models', status: 200, responseType: 'application/json; charset=utf-8', requestId: 'req_models' },
    });
  });

  it('tests Claude messages with x-api-key authentication and a bounded probe payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'msg_test' }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_claude' },
    }));

    await expect(client({ Authorization: 'Bearer attacker' }).testClaudeMessages('claude-test')).resolves.toEqual({
      endpoint: '/messages', status: 200, responseType: 'application/json', requestId: 'req_claude',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://relay.example.test/v1/messages');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe('secret-key');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'claude-test', max_tokens: 1, stream: false });
  });

  it('rejects a failed Claude probe without treating it as a healthy endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_denied' },
    }));

    await expect(client().testClaudeMessages('claude-test')).rejects.toThrow('401');
  });

  it('rejects invalid model response catalogs before they reach the provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {} }), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(client().listModels()).rejects.toThrow('invalid or excessive data array');
  });

  it('rejects null catalogs and entries without a usable model ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('null', { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('null', { headers: { 'content-type': 'application/json' } }));
    await expect(client().listModels()).rejects.toThrow('invalid or excessive data array');

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: '   ' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: '   ' }] }), { headers: { 'content-type': 'application/json' } }));
    await expect(client().listModels()).rejects.toThrow('invalid or excessive data array');
  });

  it('rejects catalogs that omit the required data array', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));

    await expect(client().listModels()).rejects.toThrow('invalid or excessive data array');
  });
});