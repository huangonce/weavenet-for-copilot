import { describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRetry, readWithIdleTimeout } from '../src/relay/http';

describe('relay HTTP safety', () => {
  it('rejects non-GET retry requests before sending them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(fetchJsonWithRetry('https://example.test', { method: 'POST' }, 100)).rejects.toThrow('only supports GET');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
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
