import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { RelayClient } from '../../src/relay/client';

const client = () => new RelayClient({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'synthetic-key', authScheme: 'x-api-key',
  requestHeaders: {}, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
const json = (value: unknown, requestId = 'req') => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
afterEach(() => vi.restoreAllMocks());

describe('bounded model pagination', () => {
  it('continues after_id on the same authenticated endpoint and includes all models', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ id: 'first' }], has_more: true, last_id: 'cursor/?x=#' }, 'first-id'))
      .mockResolvedValueOnce(json({ data: [{ id: 'second' }, { id: 'third' }], has_more: false }));
    const result = await client().testModels();
    expect(result.models.data?.map(model => model.id)).toEqual(['first', 'second', 'third']);
    expect(result.diagnostic.requestId).toBe('first-id');
    const url = new URL(String(fetch.mock.calls[1][0]));
    expect(url.origin).toBe('https://api.anthropic.com'); expect(url.pathname).toBe('/v1/models');
    expect(url.searchParams.get('after_id')).toBe('cursor/?x=#'); expect(url.searchParams.get('limit')).toBe('1000');
    const headers = new Headers(fetch.mock.calls[1][1]?.headers);
    expect(headers.get('x-api-key')).toBe('synthetic-key'); expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(fetch.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });
  it('rejects a repeated cursor without looping or following a remote next_url', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ data: [{ id: 'same' }], has_more: true,
      last_id: 'repeated', next_url: 'https://attacker.example/v1/models' }));
    await expect(client().listModels()).rejects.toThrow('repeated cursor');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.anthropic.com/v1/models'))).toBe(true);
  });
  it('rejects pagination past the aggregate entry bound', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: Array.from({ length: 10_000 }, (_, i) => ({ id: `m${i}` })), has_more: true, last_id: 'last' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'overflow' }], has_more: false }));
    await expect(client().listModels()).rejects.toThrow('aggregate directory limit');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not fetch another page after cancellation', async () => {
    const source = new vscode.CancellationTokenSource();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      source.cancel(); return json({ data: [{ id: 'first' }], has_more: true, last_id: 'cursor' });
    });
    await expect(client().listModels(source.token)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
