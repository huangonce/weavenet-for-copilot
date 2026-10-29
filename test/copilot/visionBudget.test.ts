import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CATALOG_ARTIFACT_PEPPER_SECRET, RELAY_API_KEY_SECRET } from '../../src/constants';
import { snapshotChatRequest } from '../../src/copilot/canonicalRequest';
import { estimateTextTokens } from '../../src/copilot/helpers';
import { WeaveNetChatProvider } from '../../src/copilot/provider';
import { IMAGE_ONLY_TOOL_RESULT_TEXT, normalizeToolResultBatches } from '../../src/copilot/toolResultImageNormalization';
import { estimateCanonicalTextTokens, truncateVisionDescription, visionDescriptionTokenBudget } from '../../src/copilot/visionBudget';
import * as visionProxy from '../../src/copilot/visionProxy';
import { collectVisionReplayEntries, createVisionReplayPart } from '../../src/copilot/visionReplay';
import { RelayClient } from '../../src/relay/client';
import { InMemoryMemento } from '../support/memento';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const subscriptions: vscode.Disposable[] = [];

afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  vi.restoreAllMocks();
});

const image = (bytes = 1) => new vscode.LanguageModelDataPart(new Uint8Array(bytes), 'image/png');
const frame = (text: string) => {
  const encoded = JSON.stringify(text);
  return `[Untrusted image description]\nThe next ${Buffer.byteLength(encoded, 'utf8')} UTF-8 bytes are data:\n${encoded}`;
};

describe('vision description budget', () => {
  it.each([
    [0, 128_000, 0, 0],
    [1, 128_000, 0, 1_024],
    [8, 128_000, 0, 8_192],
    [50, 128_000, 0, 8_192],
    [1, 2_048, 0, 512],
    [4, 4_000, 3_500, 500],
    [4, 4_000, 4_100, 0],
  ])('reserves %s images within input limit %s and base text %s', (images, input, base, expected) => {
    expect(visionDescriptionTokenBudget(images, input, base)).toBe(expected);
  });

  it('preserves a complete short description and its framing', () => {
    expect(truncateVisionDescription('  错误 E42 😀  ', 128, frame)).toBe(frame('错误 E42 😀'));
  });

  it.each([
    ['ASCII', 'window position and error code '.repeat(2_000)],
    ['CJK', '错误代码窗口位置'.repeat(2_000)],
    ['escaped text', '"quoted"\\path\n'.repeat(2_000)],
    ['surrogate pairs', '😀界'.repeat(2_000)],
  ])('bounds final framed %s text with the shared token estimator', (_name, description) => {
    const result = truncateVisionDescription(description, 256, frame);
    expect(estimateTextTokens(result)).toBeLessThanOrEqual(256);
    const encoded = result.split('\n')[2];
    const decoded: unknown = JSON.parse(encoded);
    expect(typeof decoded).toBe('string');
    expect(decoded).toMatch(/…$/u);
    expect(decoded).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result).toContain(`next ${Buffer.byteLength(encoded, 'utf8')} UTF-8 bytes`);
  });

  it('returns no malformed frame when even the framing cannot fit', () => {
    expect(truncateVisionDescription('description', 1, frame)).toBe('');
    expect(truncateVisionDescription('description', 0, frame)).toBe('');
  });

  it('counts canonical text and tools separately from images', () => {
    const messages = [
      { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined,
        content: [new vscode.LanguageModelToolCallPart('call', 'capture', { path: 'view' })] },
      { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [
        new vscode.LanguageModelTextPart('查看错误'),
        new vscode.LanguageModelToolResultPart('call', [new vscode.LanguageModelTextPart('result'), image()]),
      ] },
    ];
    const snapshot = snapshotChatRequest(messages);
    expect(estimateCanonicalTextTokens(snapshot.messages)).toBe(8 + estimateTextTokens('capture')
      + estimateTextTokens('{"path":"view"}') + estimateTextTokens('查看错误') + estimateTextTokens('result'));
  });
});

async function countingProvider(nativeImages: boolean, proxyEnabled = true) {
  const profile = { id: PROFILE_ID, name: 'Work', baseUrl: 'https://relay.example.test/v1',
    models: [{ id: 'model', imageInput: nativeImages }] };
  const settings: Record<string, unknown> = {
    modelMetadataEnabled: false, visionProxyEnabled: proxyEnabled, visionProxyModel: 'external/vision',
  };
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string) => settings[key],
    inspect: (key: string) => key === 'profiles' ? { globalValue: [profile] } : undefined,
  } as never);
  const provider = new WeaveNetChatProvider({
    subscriptions, globalState: new InMemoryMemento(),
    secrets: {
      get: async (key: string) => key === CATALOG_ARTIFACT_PEPPER_SECRET ? 'p'.repeat(43)
        : key === `${RELAY_API_KEY_SECRET}.profileId.${PROFILE_ID}` ? 'synthetic-key' : undefined,
      onDidChange: () => ({ dispose() {} }),
    },
  } as never);
  vi.spyOn(RelayClient.prototype, 'listModels').mockResolvedValue({ data: [{ id: 'model' }] });
  const [model] = await provider.provideLanguageModelChatInformation({ silent: false }, token);
  return { provider, model };
}

describe('provider vision token reservations', () => {
  it('reserves description space for tiny images instead of estimating their compressed bytes', async () => {
    const { provider, model } = await countingProvider(false);
    const message = vscode.LanguageModelChatMessage.User([image()]);
    await expect(provider.provideTokenCount(model, message, token)).resolves.toBe(4 + 1_024);
    await expect(provider.provideTokenCount(model,
      vscode.LanguageModelChatMessage.User([image(768 * 4)]), token)).resolves.toBe(4 + 1_024);
  });

  it('counts top-level and tool-result images against one total description reservation', async () => {
    const { provider, model } = await countingProvider(false);
    const message = vscode.LanguageModelChatMessage.User([
      image(), new vscode.LanguageModelToolResultPart('call', [image(), image()]),
    ]);
    await expect(provider.provideTokenCount(model, message, token)).resolves.toBe(4 + 3 * 1_024);
    // A narrower window must not shrink the reservation for previously saved captions.
    await expect(provider.provideTokenCount({ ...model, maxInputTokens: 2_048 }, message, token)).resolves.toBe(4 + 3 * 1_024);
  });

  it('keeps the historical caption reservation even when existing text nearly fills the window', async () => {
    const { provider, model } = await countingProvider(false);
    const message = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart('字'.repeat(1_796)), image(),
    ]);
    await expect(provider.provideTokenCount({ ...model, maxInputTokens: 2_048 }, message, token)).resolves.toBe(1_800 + 1_024);
  });

  it.each([[true, true], [false, false]])('preserves byte-based image estimates for native=%s proxy=%s', async (native, proxy) => {
    const { provider, model } = await countingProvider(native, proxy);
    const message = vscode.LanguageModelChatMessage.User([
      image(), new vscode.LanguageModelToolResultPart('call', [image()]),
    ]);
    await expect(provider.provideTokenCount(model, message, token))
      .resolves.toBe(4 + 2 * 256 + estimateTextTokens(IMAGE_ONLY_TOOL_RESULT_TEXT));
  });

  it('keeps plain text and cancellation behavior', async () => {
    const { provider, model } = await countingProvider(false);
    await expect(provider.provideTokenCount(model, '你好abcd', token)).resolves.toBe(3);
    await expect(provider.provideTokenCount(model, vscode.LanguageModelChatMessage.User('你好abcd'), token)).resolves.toBe(7);
    await expect(provider.provideTokenCount(model, vscode.LanguageModelChatMessage.User([image()]),
      { ...token, isCancellationRequested: true })).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('reserves the user message created when mixed tool and direct images are normalized', async () => {
    const { provider, model } = await countingProvider(false);
    const messages = [
      vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart('call', 'capture', {})]),
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart('字'.repeat(373)),
        new vscode.LanguageModelToolResultPart('call', [image()]), image(2),
      ]),
    ];
    vi.spyOn(vscode.lm, 'selectChatModels').mockResolvedValue([{
      vendor: 'external', id: 'vision',
      sendRequest: async () => ({ stream: (async function* () {
        yield new vscode.LanguageModelTextPart('汉'.repeat(8_000));
      })() }),
    }] as never);
    const resolve = vi.spyOn(visionProxy, 'resolveVisionProxyMessages');
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (_request, callbacks) => {
      callbacks.onContent('done');
      callbacks.onStreamEnd?.('OpenAI', '[DONE]');
    });

    await provider.provideLanguageModelChatResponse({ ...model, maxInputTokens: 512 }, messages,
      { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: vi.fn() }, token);

    expect(stream).toHaveBeenCalledOnce();
    const resolved = await resolve.mock.results[0].value;
    const normalized = normalizeToolResultBatches(resolved.messages);
    expect(normalized.messages).toHaveLength(3);
    expect(estimateCanonicalTextTokens(normalized.messages)).toBeLessThanOrEqual(512);
  });
});

describe('vision cache budgets and stable history', () => {
  const config = { visionProxyModel: 'external/vision', visionProxyPrompt: 'Read exactly.' };
  const identity = 'a'.repeat(64);
  const sourceMessage = () => vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('Read code'), image()]);
  const assistant = (entries: Parameters<typeof createVisionReplayPart>[1]): vscode.LanguageModelChatRequestMessage => ({
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelTextPart('Done'), createVisionReplayPart(identity, entries)!],
    name: undefined,
  });

  it.each(['large', 'small'])('fits a current cache hit to 512 input tokens on target %s without another vision request', async targetId => {
    const cache = new visionProxy.VisionDescriptionCache();
    const describe = vi.fn().mockResolvedValue('汉'.repeat(8_000));
    const getDescriber = vi.fn().mockResolvedValue({ identity: { vendor: 'external', id: 'vision' }, describe });
    const source = snapshotChatRequest([sourceMessage()]);
    const first = await visionProxy.resolveVisionProxyMessages(source, config, { vendor: 'weavenet', id: 'large' },
      token, cache, getDescriber, { maxInputTokens: 128_000 });
    cache.commitAll(first.pendingCacheWrites);
    const storedBytes = cache.descriptionBytes;

    const current = await visionProxy.resolveVisionProxyMessages(source, config, { vendor: 'weavenet', id: targetId },
      token, cache, getDescriber, { maxInputTokens: 512 });

    expect(describe).toHaveBeenCalledOnce();
    expect(estimateTextTokens(first.replayEntries[0].text)).toBe(1_024);
    expect(estimateTextTokens(current.replayEntries[0].text)).toBeLessThanOrEqual(128);
    expect(estimateCanonicalTextTokens(current.messages.messages)).toBeLessThanOrEqual(512);
    expect(current.pendingCacheWrites).toEqual([]);
    expect(cache.descriptionBytes).toBe(storedBytes);
    cache.clear();
  });

  it('retains different caption lengths for identical images in successive turns after cache loss', async () => {
    const cache = new visionProxy.VisionDescriptionCache();
    const describe = vi.fn().mockResolvedValue('汉'.repeat(8_000));
    const getDescriber = vi.fn().mockResolvedValue({ identity: { vendor: 'external', id: 'vision' }, describe });
    const target = { vendor: 'weavenet', id: 'same-target' };
    const first = await visionProxy.resolveVisionProxyMessages(snapshotChatRequest([sourceMessage()]), config, target,
      token, cache, getDescriber, { maxInputTokens: 128_000 });
    cache.commitAll(first.pendingCacheWrites);
    const repeatedMessages = [sourceMessage(), assistant(first.replayEntries), sourceMessage()];
    const repeatedSnapshot = snapshotChatRequest(repeatedMessages);
    const second = await visionProxy.resolveVisionProxyMessages(repeatedSnapshot, config, target,
      token, cache, getDescriber, { maxInputTokens: 2_048, replayEntries: collectVisionReplayEntries(repeatedSnapshot, identity) });
    expect(second.replayEntries).toHaveLength(2);
    expect(new Set(second.replayEntries.map(entry => entry.key)).size).toBe(2);
    expect(second.replayEntries.map(entry => estimateTextTokens(entry.text))).toEqual([1_024, 512]);
    const history = snapshotChatRequest([...repeatedMessages, assistant(second.replayEntries),
      vscode.LanguageModelChatMessage.User('Continue')]);
    const entries = collectVisionReplayEntries(history, identity);
    expect(entries.size).toBe(2);
    cache.clear();

    const continuation = await visionProxy.resolveVisionProxyMessages(history, config, target, token, cache, getDescriber,
      { maxInputTokens: 2_048, replayEntries: entries });

    expect(describe).toHaveBeenCalledOnce();
    expect(continuation.messages.messages[0]).toEqual(first.messages.messages[0]);
    expect(continuation.messages.messages[2]).toEqual(second.messages.messages[2]);
    expect(continuation.replayEntries).toEqual(second.replayEntries);
  });
});
