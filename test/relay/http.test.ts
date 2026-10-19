import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { fetchJsonWithRetry, fetchJsonWithRetryMetadata, fetchWithResponseTimeout, readResponseText, readSseStream, readWithIdleTimeout, throwIfNotOk } from '../../src/relay/http';

afterEach(() => vi.restoreAllMocks());

function controlledCancellationToken(): { token: vscode.CancellationToken; cancel(): void } {
  let cancellationRequested = false;
  let notifyCancellation: (() => void) | undefined;
  const token: vscode.CancellationToken = {
    get isCancellationRequested() { return cancellationRequested; },
    onCancellationRequested: (listener, thisArgs, disposables) => {
      const disposable = { dispose: () => { notifyCancellation = undefined; } };
      notifyCancellation = () => listener.call(thisArgs, undefined);
      disposables?.push(disposable);
      return disposable;
    },
  };
  return {
    token,
    cancel: () => {
      cancellationRequested = true;
      notifyCancellation?.();
    },
  };
}

describe('shared SSE reader', () => {
  function chunksResponse(value: string, bytewise = false): Response {
    const bytes = new TextEncoder().encode(value);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
      },
    }));
  }

  it.each(['\n', '\r\n', '\r'])('folds data fields and decodes UTF-8 with %j line endings across byte boundaries', async (newline) => {
    const response = chunksResponse([
      '\uFEFF: heartbeat',
      'event: message',
      'id: ignored',
      'data:  汉🙂',
      'data: second',
      'data',
      '',
      '',
    ].join(newline), true);
    const onEventData = vi.fn(() => false);

    await expect(readSseStream(response, { protocol: 'OpenAI', idleTimeoutMs: 1_000, onEventData })).resolves.toBe(false);

    expect(onEventData).toHaveBeenCalledExactlyOnceWith(' 汉🙂\nsecond\n');
    expect(response.body?.locked).toBe(false);
  });

  it('treats split CRLF as one line ending and supports mixed newline styles', async () => {
    const onEventData = vi.fn(() => false);
    await readSseStream(chunksResponse('data: first\r\ndata: second\rdata: third\n\r\n', true), {
      protocol: 'Claude', idleTimeoutMs: 1_000, onEventData,
    });
    expect(onEventData).toHaveBeenCalledExactlyOnceWith('first\nsecond\nthird');
  });

  it.each(['', '\n', '\r', '\r\n'])('discards the pending event at EOF after %j', async (ending) => {
    const onEventData = vi.fn(() => false);
    await expect(readSseStream(chunksResponse(`data: incomplete${ending}`, true), {
      protocol: 'Responses', idleTimeoutMs: 1_000, onEventData,
    })).resolves.toBe(false);
    expect(onEventData).not.toHaveBeenCalled();
  });

  it('dispatches an empty data field but ignores comments and unrelated fields', async () => {
    const onEventData = vi.fn(() => false);
    await readSseStream(chunksResponse(': heartbeat\nunknown: ignored\n\ndata\n\n'), {
      protocol: 'OpenAI', idleTimeoutMs: 1_000, onEventData,
    });
    expect(onEventData).toHaveBeenCalledExactlyOnceWith('');
  });

  it('stops at the protocol terminal event and releases an open reader', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: terminal\n\ndata: ignored\n\n')); },
      cancel,
    }));
    const onEventData = vi.fn(() => true);

    await expect(readSseStream(response, { protocol: 'Responses', idleTimeoutMs: 1_000, onEventData })).resolves.toBe(true);

    expect(onEventData).toHaveBeenCalledExactlyOnceWith('terminal');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('bounds a whole event assembled from individually small data lines', async () => {
    const onEventData = vi.fn(() => false);
    await expect(readSseStream(chunksResponse('data: aa\ndata: bb\ndata: cc\n\n', true), {
      protocol: 'Claude', idleTimeoutMs: 1_000, maxEventBytes: 20, onEventData,
    })).rejects.toThrow('SSE event exceeds 20 bytes');
    expect(onEventData).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes and bounds an unterminated line', async () => {
    await expect(readSseStream(chunksResponse('data: 汉汉', true), {
      protocol: 'OpenAI', idleTimeoutMs: 1_000, maxEventBytes: 11, onEventData: () => false,
    })).rejects.toThrow('SSE event exceeds 11 bytes');
  });

  it('resets the event budget between many events in one large network chunk', async () => {
    const onEventData = vi.fn(() => false);
    await readSseStream(chunksResponse('data: ok\n\n'.repeat(10_000)), {
      protocol: 'OpenAI', idleTimeoutMs: 1_000, maxEventBytes: 16, onEventData,
    });
    expect(onEventData).toHaveBeenCalledTimes(10_000);
  });

  it('propagates protocol errors and releases the reader', async () => {
    const response = chunksResponse('data: invalid\n\n');
    const failure = new Error('protocol error');
    await expect(readSseStream(response, {
      protocol: 'Responses', idleTimeoutMs: 1_000, onEventData: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it('cancels an idle reader and releases its lock after timeout', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    await expect(readSseStream(response, {
      protocol: 'Claude', idleTimeoutMs: 5, onEventData: () => false,
    })).rejects.toMatchObject({ name: 'RelayTimeoutError', phase: 'stream' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('honors cancellation while waiting for the next event', async () => {
    const cancellation = controlledCancellationToken();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const pending = readSseStream(response, {
      protocol: 'OpenAI', idleTimeoutMs: 1_000, token: cancellation.token, onEventData: () => false,
    });
    cancellation.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'CancellationError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});

describe('relay HTTP safety', () => {
  it('refuses redirects for authenticated Relay requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await fetchWithResponseTimeout('https://example.test/models', {
      headers: { Authorization: 'Bearer secret' },
    }, 100);

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/models', expect.objectContaining({ redirect: 'error' }));
  });

  it('reports successful fetch transport state without exposing request details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const onSettled = vi.fn();

    await fetchWithResponseTimeout('https://example.test/models', {}, 100, undefined, onSettled);

    expect(onSettled).toHaveBeenCalledWith({
      responseReceived: true,
      signalAborted: false,
      abortSource: 'none',
      tokenCancellationRequested: false,
    });
  });

  it('reports VS Code cancellation as the fetch abort source', async () => {
    const cancellation = controlledCancellationToken();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const onSettled = vi.fn();
    const pending = fetchWithResponseTimeout('https://example.test', {}, 1_000, cancellation.token, onSettled);

    cancellation.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(onSettled).toHaveBeenCalledWith({
      responseReceived: false,
      signalAborted: true,
      abortSource: 'vscode',
      tokenCancellationRequested: true,
    });
  });

  it('reports timeout as the fetch abort source', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const onSettled = vi.fn();

    await expect(fetchWithResponseTimeout('https://example.test', {}, 5, undefined, onSettled))
      .rejects.toMatchObject({ name: 'RelayTimeoutError' });
    expect(onSettled).toHaveBeenCalledWith({
      responseReceived: false,
      signalAborted: true,
      abortSource: 'timeout',
      tokenCancellationRequested: false,
    });
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
    const cancellation = controlledCancellationToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
    ));
    const pending = fetchJsonWithRetry('https://example.test/models', {}, 1_000, cancellation.token);
    cancellation.cancel();
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
    const cancellation = controlledCancellationToken();
    const cancel = vi.fn();
    const reader = {
      read: () => new Promise<never>(() => undefined),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const pending = readWithIdleTimeout(reader, 1_000, cancellation.token);
    cancellation.cancel();
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
    const cancellation = controlledCancellationToken();
    const pending = throwIfNotOk(new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 500 },
    ), 1_000, cancellation.token);

    cancellation.cancel();
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
