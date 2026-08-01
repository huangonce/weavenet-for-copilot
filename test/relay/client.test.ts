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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_test', content: [{ type: 'text', text: 'OK' }],
    }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_claude' },
    }));

    await expect(client({ Authorization: 'Bearer attacker' }).testClaudeMessages('claude-test')).resolves.toEqual({
      endpoint: '/messages', status: 200, responseType: 'application/json', requestId: 'req_claude', stream: false,
      termination: 'message_stop',
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

  it('strictly probes OpenAI streaming once without non-stream fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_openai' } },
    ));
    await expect(client().testOpenAIChatCompletion('gpt-test', true)).resolves.toMatchObject({
      endpoint: '/chat/completions', stream: true, termination: '[DONE]', requestId: 'req_openai',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'gpt-test', max_tokens: 1, stream: true });
  });

  it('strictly probes Claude streaming through message_stop', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(client().testClaudeMessages('claude-test', true)).resolves.toMatchObject({
      endpoint: '/messages', stream: true, termination: 'message_stop',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects successful HTML and non-terminal streams as invalid protocol responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }));
    await expect(client().testClaudeMessages('claude-test')).rejects.toThrow();
    await expect(client().testOpenAIChatCompletion('gpt-test', true)).rejects.toThrow('terminal event');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('probes OpenAI Responses with a single bounded POST and reports completion', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_resp' },
    }));

    await expect(client().testOpenAIResponses('gpt-test')).resolves.toMatchObject({
      endpoint: '/responses', status: 200, responseType: 'application/json', requestId: 'req_resp',
      stream: false, termination: 'completed',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://relay.example.test/v1/responses');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('gpt-test');
    expect(body.max_output_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(body.input).toEqual([{ role: 'user', content: 'OK' }]);
  });

  it('probes OpenAI Responses streaming through the completed event', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_resp_stream' } },
    ));

    await expect(client().testOpenAIResponses('gpt-test', true)).resolves.toMatchObject({
      endpoint: '/responses', stream: true, termination: 'completed', requestId: 'req_resp_stream',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'gpt-test', stream: true });
  });

  it('rejects an unsuccessful Responses probe without falling back', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model does not support responses' },
    }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_missing' },
    }));

    await expect(client().testOpenAIResponses('gpt-test')).rejects.toThrow('404');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/responses');
  });

  it('reports /responses endpoint availability from a free GET', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await expect(client().probeResponsesEndpoint()).resolves.toBe('supported');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 405 }));
    await expect(client().probeResponsesEndpoint()).resolves.toBe('supported');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    await expect(client().probeResponsesEndpoint()).resolves.toBe('unsupported');
  });

  it('returns unknown when the /responses availability GET fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    await expect(client().probeResponsesEndpoint()).resolves.toBe('unknown');
  });

  it('sanitizes and bounds successful response metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': `application/json${'x'.repeat(300)}`, 'x-request-id': `req${'y'.repeat(200)}` },
    }));
    const result = await client().testModels();
    expect(result.diagnostic.responseType.length).toBeLessThanOrEqual(200);
    expect(result.diagnostic.requestId?.length).toBeLessThanOrEqual(100);
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