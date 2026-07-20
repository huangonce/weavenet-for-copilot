import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRetry, fetchJsonWithRetryMetadata, fetchWithResponseTimeout, readResponseText, readWithIdleTimeout, throwIfNotOk } from '../../src/relay/http';

afterEach(() => vi.restoreAllMocks());

describe('relay HTTP safety', () => {
  it('refuses redirects for authenticated Relay requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await fetchWithResponseTimeout('https://example.test/models', {
      headers: { Authorization: 'Bearer secret' },
    }, 100);

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/models', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects non-GET retry requests before sending them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(fetchJsonWithRetry('https://example.test', { method: 'POST' }, 100)).rejects.toThrow('only supports GET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the request timeout active while reading a JSON body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { headers: { 'content-type': 'application/json' } },
    ));
    await expect(fetchJsonWithRetry('https://example.test/models', {}, 5)).rejects.toMatchObject({
      name: 'RelayTimeoutError',
      phase: 'response',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'invalid key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    await expect(fetchJsonWithRetry('https://example.test/models', {}, 100)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a JSON response body that exceeds its configured limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"data":[]}'));
    await expect(fetchJsonWithRetry('https://example.test/models', {}, 100, undefined, 4)).rejects.toThrow('exceeds 4 bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries one server error and returns the second JSON response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      }));
    await expect(fetchJsonWithRetry('https://example.test/models', {}, 100)).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns safe HTTP response metadata for a successful model request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_models' },
    }));
    await expect(fetchJsonWithRetryMetadata('https://example.test/models', {}, 100)).resolves.toEqual({
      value: { data: [] },
      status: 200,
      contentType: 'application/json',
      requestId: 'req_models',
    });
  });

  it('cancels while reading a JSON body without retrying', async () => {
    let cancelListener: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancelListener = listener;
        return { dispose() {} };
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
    ));
    const pending = fetchJsonWithRetry('https://example.test/models', {}, 1_000, token);
    cancelListener?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('times out an idle stream reader', async () => {
    const reader = new ReadableStream<Uint8Array>({ start() {} }).getReader();
    await expect(readWithIdleTimeout(reader, 5)).rejects.toMatchObject({
      name: 'RelayTimeoutError',
      phase: 'stream',
    });
  });

  it('cancels a stream reader when the cancellation token fires', async () => {
    let cancelListener: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancelListener = listener;
        return { dispose() {} };
      },
    };
    const cancel = vi.fn();
    const reader = {
      read: () => new Promise<never>(() => undefined),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const pending = readWithIdleTimeout(reader, 1_000, token);
    cancelListener?.();
    await expect(pending).rejects.toMatchObject({ name: 'CancellationError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('releases a complete-response reader after a parsing callback throws', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValue({ value: new TextEncoder().encode('body'), done: false }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    (reader.read as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('read failed'));
    const response = { body: { getReader: () => reader } } as unknown as Response;

    await expect(readResponseText(response, 100)).rejects.toThrow('read failed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds error response bodies before creating a request error', async () => {
    await expect(throwIfNotOk(new Response('x'.repeat(32), { status: 500 }), 100, undefined, 8))
      .rejects.toMatchObject({ status: 500 });
  });

  it('preserves cancellation while reading an error response body', async () => {
    let cancelListener: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancelListener = listener;
        return { dispose() {} };
      },
    };
    const pending = throwIfNotOk(new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 500 },
    ), 1_000, token);

    cancelListener?.();
    await expect(pending).rejects.toMatchObject({ name: 'CancellationError' });
  });

  it('preserves idle timeouts while reading an error response body', async () => {
    await expect(throwIfNotOk(new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 500 },
    ), 5)).rejects.toMatchObject({ name: 'RelayTimeoutError', phase: 'stream' });
  });

  it('rejects and cancels a complete response body above its limit', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ value: new TextEncoder().encode('too large'), done: false }),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { body: { getReader: () => reader } } as unknown as Response;

    await expect(readResponseText(response, 100, undefined, 4)).rejects.toThrow('exceeds 4 bytes');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
