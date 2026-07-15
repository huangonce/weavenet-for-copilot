import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRetry, readWithIdleTimeout } from '../src/relay/http';

afterEach(() => vi.restoreAllMocks());

describe('relay HTTP safety', () => {
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
});
