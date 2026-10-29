import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { VisionDescriptionCache, VSCodeLanguageModelVisionDescriber } from '../../src/copilot/visionProxy';
import { estimateTextTokens } from '../../src/copilot/helpers';

const token: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};

function fixture(cleanup: (modelToken: vscode.CancellationToken) => Promise<IteratorResult<unknown>>) {
  let modelToken: vscode.CancellationToken;
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<unknown>> => ({
      done: false, value: new vscode.LanguageModelTextPart('x'.repeat(48 * 1024)),
    })),
    return: vi.fn(() => cleanup(modelToken)),
  };
  const model = {
    vendor: 'copilot', id: 'vision',
    sendRequest: async (_messages: unknown, _options: unknown, requestToken: vscode.CancellationToken) => {
      modelToken = requestToken;
      return { stream: { [Symbol.asyncIterator]: () => iterator } };
    },
  } as unknown as vscode.LanguageModelChat;
  const describer = new VSCodeLanguageModelVisionDescriber(model);
  return { iterator, describe: (requestToken = token, maxTokens?: number) => describer.describe({ prompt: 'Describe.', images: [], token: requestToken, maxTokens }) };
}

afterEach(() => vi.useRealTimers());

describe('vision description output-cap cleanup', () => {
  it('keeps bounded text when cleanup acknowledges the deliberate local cancellation', async () => {
    const { describe: generate, iterator } = fixture(async modelToken => {
      expect(modelToken.isCancellationRequested).toBe(true);
      throw new vscode.CancellationError();
    });
    const cache = new VisionDescriptionCache();
    const result = await cache.describeOnce('image', token, generate);

    expect(result.description).toMatch(/^x+…$/u);
    expect(Buffer.byteLength(result.description, 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(iterator.next).toHaveBeenCalledOnce();
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(token.isCancellationRequested).toBe(false);
    expect(cache.activeWorkCount).toBe(0);
    cache.releasePending([{ key: 'image', visionText: result.description, lease: result.lease }]);
    expect(cache.flightCount).toBe(0);
  });

  it('still rejects user cancellation during output-cap cleanup', async () => {
    const external = new vscode.CancellationTokenSource();
    const { describe: generate } = fixture(async () => {
      external.cancel();
      throw new vscode.CancellationError();
    });
    try {
      await expect(generate(external.token)).rejects.toBeInstanceOf(vscode.CancellationError);
      expect(external.token.isCancellationRequested).toBe(true);
    } finally {
      external.dispose();
    }
  });

  it('does not suppress unrelated cleanup failures', async () => {
    const failure = new Error('cleanup failed');
    const { describe: generate } = fixture(async () => { throw failure; });
    await expect(generate()).rejects.toBe(failure);
  });

  it('retains the idle timeout when cleanup never settles', async () => {
    vi.useFakeTimers();
    const { describe: generate } = fixture(() => new Promise(() => {}));
    const pending = generate();
    const rejected = expect(pending).rejects.toMatchObject({ message: expect.stringContaining('stopped responding') });
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
  });

  it('does not turn a stream cancellation before the output cap into partial success', async () => {
    const failure = new vscode.CancellationError();
    const { describe: generate, iterator } = fixture(async () => ({ done: true, value: undefined }));
    iterator.next.mockResolvedValueOnce({ done: false, value: new vscode.LanguageModelTextPart('partial') })
      .mockRejectedValueOnce(failure);
    await expect(generate()).rejects.toBe(failure);
  });

  it.each([
    { kind: 'ordinary chunks', chunks: ['汉'.repeat(7), '字'.repeat(3)], reads: 2 },
    { kind: 'one oversized chunk', chunks: ['汉'.repeat(48 * 1024)], reads: 1 },
  ])('stops at the token budget with $kind and keeps the externally uncancelled result', async ({ chunks, reads }) => {
    const { describe: generate, iterator } = fixture(async modelToken => {
      expect(modelToken.isCancellationRequested).toBe(true);
      throw new vscode.CancellationError();
    });
    for (const chunk of chunks) iterator.next.mockResolvedValueOnce({ done: false, value: new vscode.LanguageModelTextPart(chunk) });
    iterator.next.mockRejectedValue(new Error('must not consume another chunk after exceeding the token budget'));

    const description = await generate(token, 8);

    expect(description).not.toBe('');
    expect(estimateTextTokens(description)).toBeLessThanOrEqual(8);
    expect(description).toMatch(/…$/u);
    expect(description).not.toContain('\uFFFD');
    expect(iterator.next).toHaveBeenCalledTimes(reads);
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(token.isCancellationRequested).toBe(false);
  });
});
