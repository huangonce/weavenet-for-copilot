import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  ConnectionTestError,
  describeConnectionTestError,
  estimateTextTokens,
  getConfiguredContextWindow,
  getConfiguredReasoningEffort,
  parseToolArguments,
  safeEndpoint,
  safeHost,
  shouldApplyTestConnectionStatus,
  shouldInvalidateModelRefresh,
  toClaudeThinking,
  toLanguageModelError,
  WeaveNetChatProvider,
} from '../../src/copilot/provider';
import { RELAY_API_KEY_SECRET } from '../../src/constants';
import { RelayRequestError, RelayStreamError } from '../../src/relay/errors';
import { RelayTimeoutError } from '../../src/relay/http';
import { RelayClient } from '../../src/relay/client';
import { InMemoryMemento } from '../support/memento';

class InMemorySecrets {
  readonly values = new Map<string, string>();
  private readonly listeners = new Set<(event: { key: string }) => void>();

  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    this.fire(key);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.fire(key);
  }
  onDidChange(listener: (event: { key: string }) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  private fire(key: string): void {
    for (const listener of this.listeners) listener({ key });
  }
}

function providerFixture(
  activeProfile = 'work',
  configValues: Record<string, unknown> = {},
): { provider: WeaveNetChatProvider; secrets: InMemorySecrets; setActiveProfile(value: string): void } {
  let currentActiveProfile = activeProfile;
  const profiles = [
    { name: 'work', baseUrl: 'https://work.example.test/v1' },
    { name: 'personal', baseUrl: 'https://personal.example.test/v1' },
  ];
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: <T>(key: string) => configValues[key] as T | undefined,
    inspect: <T>(key: string) => key === 'profiles'
      ? { globalValue: profiles as T }
      : key === 'activeProfile'
        ? { globalValue: currentActiveProfile as T }
        : undefined,
  } as never);
  const secrets = new InMemorySecrets();
  const provider = new WeaveNetChatProvider({ secrets, globalState: new InMemoryMemento(), subscriptions: [] } as never);
  return { provider, secrets, setActiveProfile: (value) => { currentActiveProfile = value; } };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe('model refresh invalidation', () => {
  it('reuses an in-flight refresh for passive duplicate requests on one connection', () => {
    expect(shouldInvalidateModelRefresh('passive', 'work', 'work')).toBe(false);
  });

  it('invalidates an in-flight refresh after a secret or configuration change', () => {
    expect(shouldInvalidateModelRefresh('invalidate', 'work', 'work')).toBe(true);
  });

  it('invalidates an in-flight refresh when the active connection changes', () => {
    expect(shouldInvalidateModelRefresh('passive', 'work', 'personal')).toBe(true);
  });

  it('updates the global connection status only for the active connection test', () => {
    expect(shouldApplyTestConnectionStatus('work', 'work')).toBe(true);
    expect(shouldApplyTestConnectionStatus('work', 'personal')).toBe(false);
    expect(shouldApplyTestConnectionStatus(undefined, 'personal')).toBe(false);
  });

  it('coalesces passive duplicate model refreshes into one Relay request', async () => {
    const { provider, secrets } = providerFixture();
    await secrets.store(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      headers: { 'content-type': 'application/json' },
    }));

    await Promise.all([provider.refreshModels(), provider.refreshModels()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'ready', connectionName: 'work', modelCount: 1 });
  });

  it('reuses a resolved model catalog for sequential passive refreshes', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    }));

    await provider.refreshModels();
    await provider.refreshModels();
    await provider.provideLanguageModelChatInformation({} as never, {} as never);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'ready', modelCount: 0 });
  });

  it('keeps silent model discovery quiet and notifies after an explicit refresh', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const information = vi.spyOn(vscode.window, 'showInformationMessage');

    await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);
    expect(information).not.toHaveBeenCalled();

    await provider.refreshModels('invalidate', true);
    expect(information).toHaveBeenCalledOnce();
    expect(information).toHaveBeenCalledWith('WeaveNet loaded 1 model(s).');
  });

  it('does not transfer an explicit refresh notification to another connection', async () => {
    const { provider, secrets, setActiveProfile } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.personal`, 'personal-key');
    let resolveWork: ((response: Response) => void) | undefined;
    let signalWorkStarted: (() => void) | undefined;
    const workStarted = new Promise<void>((resolve) => { signalWorkStarted = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('work.example.test')) {
        return new Promise<Response>((resolve) => {
          resolveWork = resolve;
          signalWorkStarted?.();
        });
      }
      return new Response(JSON.stringify({ data: [{ id: 'gpt-personal' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const information = vi.spyOn(vscode.window, 'showInformationMessage');

    const workRefresh = provider.refreshModels('invalidate', true);
    await workStarted;
    setActiveProfile('personal');
    const personalRefresh = provider.refreshModels('invalidate');
    resolveWork?.(new Response(JSON.stringify({ data: [{ id: 'gpt-work' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.all([workRefresh, personalRefresh]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.getConnectionStatus()).toMatchObject({ connectionName: 'personal', modelCount: 1 });
    expect(information).not.toHaveBeenCalled();
  });

  it('does not reload after a model change event causes VS Code to query the picker', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const pickerQueries: Promise<vscode.LanguageModelChatInformation[]>[] = [];
    const subscription = provider.onDidChangeLanguageModelChatInformation(() => {
      pickerQueries.push(provider.provideLanguageModelChatInformation({} as never, {} as never));
    });

    await provider.refreshModels();
    await Promise.all(pickerQueries);
    subscription.dispose();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reloads a resolved model catalog when explicitly invalidated', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-test' }] }),
      { headers: { 'content-type': 'application/json' } },
    ));

    await provider.refreshModels();
    await provider.refreshModels('invalidate');

    const modelRequests = fetchMock.mock.calls.filter(([input]) => String(input).includes('work.example.test'));
    expect(modelRequests).toHaveLength(2);
  });

  it('does not commit an old model result after the active key is deleted in flight', async () => {
    const { provider, secrets } = providerFixture();
    const key = `${RELAY_API_KEY_SECRET}.profile.work`;
    await secrets.store(key, 'work-key');
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));

    const refresh = provider.refreshModels();
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledOnce();
    await secrets.delete(key);
    resolveResponse?.(new Response(JSON.stringify({ data: [{ id: 'stale-model' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await refresh;

    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'keyMissing', connectionName: 'work', modelCount: 0 });
  });

  it('keeps the active status unchanged when testing a non-active connection', async () => {
    const { provider, secrets } = providerFixture('work');
    await secrets.store(`${RELAY_API_KEY_SECRET}.profile.personal`, 'personal-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-personal' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await flushAsyncWork();
    const activeStatus = provider.getConnectionStatus();

    await provider.testConnection({ name: 'personal', baseUrl: 'https://personal.example.test/v1' });

    expect(provider.getConnectionStatus()).toEqual(activeStatus);
  });

  it('returns model diagnostics while treating a failed optional Claude probe as a warning', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'claude-test' }, { id: 'gpt-test' }] }), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'models-request' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'denied' } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-request-id': 'openai-request' },
      }))
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: 'denied' } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-request-id': 'claude-request' },
      }));

    await expect(provider.testConnection({ name: 'work', baseUrl: 'https://work.example.test/v1' })).resolves.toMatchObject({
      connectionName: 'work',
      host: 'work.example.test',
      modelCount: 2,
      overall: 'degraded',
      probes: expect.arrayContaining([
        expect.objectContaining({ probe: 'models', verdict: 'supported', requestId: 'models-request' }),
        expect.objectContaining({ probe: 'claude.nonStreaming', verdict: 'indeterminate' }),
      ]),
    });
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'degraded', modelCount: 2 });
  });

  it('reports invalid URLs and missing keys with structured connection failures', async () => {
    const { provider } = providerFixture();

    await expect(provider.testConnection({ name: 'work', baseUrl: 'ftp://relay.example.test' })).rejects.toMatchObject({
      failure: { category: 'url' },
    });
    await expect(provider.testConnection({ name: 'work', baseUrl: 'https://work.example.test/v1' })).rejects.toMatchObject({
      failure: { category: 'authentication' },
    });
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'keyMissing', modelCount: 0 });
  });

  it('classifies Relay errors consistently for UI connection tests and chat responses', () => {
    const unauthorized = new RelayRequestError('denied', 401, 'json', 'bad_key', 'authentication_error', 'req-1');
    expect(describeConnectionTestError(unauthorized)).toMatchObject({
      category: 'authentication', status: 401, requestId: 'req-1',
    });
    expect(describeConnectionTestError(new RelayTimeoutError())).toMatchObject({ category: 'timeout' });
    expect(describeConnectionTestError(new TypeError('fetch failed'))).toMatchObject({ category: 'network' });
    expect(describeConnectionTestError(new ConnectionTestError({ category: 'server', message: 'already classified' })))
      .toEqual({ category: 'server', message: 'already classified' });

    expect(toLanguageModelError(unauthorized)).toMatchObject({ code: 'NoPermissions' });
    expect(toLanguageModelError(new RelayRequestError('missing', 404, 'json'))).toMatchObject({ code: 'NotFound' });
    expect(toLanguageModelError(new RelayStreamError('quota reached', 'OpenAI', 'quota_exceeded')))
      .toMatchObject({ code: 'Blocked' });
  });

  it('estimates text, tool, result, and image token counts', async () => {
    const { provider } = providerFixture();
    const message = {
      content: [
        new vscode.LanguageModelTextPart('你好abcd'),
        new vscode.LanguageModelToolCallPart('call-1', 'search', { q: 'docs' }),
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('result')]),
        new vscode.LanguageModelDataPart(new Uint8Array(768), 'image/png'),
      ],
    } as never;

    await expect(provider.provideTokenCount({} as never, '你好abcd', {} as never)).resolves.toBe(3);
    await expect(provider.provideTokenCount({} as never, message, {} as never)).resolves.toBeGreaterThan(260);
  });
});

describe('Provider request helpers', () => {
  const thinkingModel = {
    id: 'reasoning-model',
    pickerId: 'reasoning-model',
    upstreamId: 'reasoning-model',
    protocol: 'openai',
    route: 'openai',
    thinking: true,
    contextWindows: [200_000, 400_000],
  } as never;

  it('normalizes safe relay hosts and endpoint paths without leaking URL credentials', () => {
    expect(safeHost('https://user:pass@relay.example.test/v1?secret=yes')).toBe('relay.example.test');
    expect(safeHost('file:///tmp/relay')).toBeUndefined();
    expect(safeEndpoint('https://user:pass@relay.example.test/v1/?secret=yes#hash', '/models'))
      .toBe('https://relay.example.test/v1/models');
    expect(safeEndpoint('not a URL', '/models')).toBe('/models');
  });

  it('reads supported reasoning and context options with deterministic fallbacks', () => {
    expect(getConfiguredReasoningEffort(thinkingModel, { modelOptions: { reasoningEffort: 'max' } } as never)).toBe('max');
    expect(getConfiguredReasoningEffort(thinkingModel, { configuration: { reasoningEffort: 'invalid' } } as never)).toBe('high');
    expect(getConfiguredReasoningEffort({ ...thinkingModel, thinking: false }, {} as never)).toBeUndefined();
    expect(getConfiguredContextWindow(thinkingModel, { modelConfiguration: { contextWindow: '400000' } } as never)).toBe(400_000);
    expect(getConfiguredContextWindow(thinkingModel, { configuration: { contextWindow: '999999' } } as never)).toBeUndefined();
    expect(getConfiguredContextWindow(thinkingModel, { configuration: { contextWindow: 'default' } } as never)).toBeUndefined();
  });

  it('creates bounded Claude thinking budgets and validates Relay tool arguments', () => {
    expect(toClaudeThinking('low', 1_024)).toBeUndefined();
    expect(toClaudeThinking('max', 9_000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 7_976 } });
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments('{"path":"README.md"}')).toEqual({ path: 'README.md' });
    expect(() => parseToolArguments('[]')).toThrow('invalid tool call arguments');
    expect(() => parseToolArguments('{')).toThrow('invalid tool call arguments');
    expect(estimateTextTokens('你好abcd')).toBe(3);
    expect(estimateTextTokens('')).toBe(1);
  });
});

describe('Provider chat responses', () => {
  const token = { isCancellationRequested: false } as never;
  const progress = () => ({ report: vi.fn() });
  const openAIModel = {
    id: 'gpt-test', pickerId: 'gpt-test', upstreamId: 'gpt-test', protocol: 'openai', route: 'openai',
    toolCalling: true, thinking: true, contextWindows: [128_000],
  } as never;
  const claudeModel = {
    id: 'claude-test', pickerId: 'claude-test', upstreamId: 'claude-test', protocol: 'claude', route: 'claude',
    toolCalling: true, thinking: true,
  } as never;

  async function readyProvider(model: typeof openAIModel | typeof claudeModel, configValues: Record<string, unknown> = {}) {
    const { provider, secrets } = providerFixture('work', { sendMaxTokens: true, supportsToolCalling: true, ...configValues });
    secrets.values.set(`${RELAY_API_KEY_SECRET}.profile.work`, 'work-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: model.id }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await provider.refreshModels();
    (provider as unknown as { cachedModels: unknown[] }).cachedModels = [model];
    return provider;
  }

  it('provides refreshed picker information with connection key state', async () => {
    const provider = await readyProvider(openAIModel);
    const information = await provider.provideLanguageModelChatInformation({} as never, token);
    expect(information).toEqual([expect.objectContaining({
      id: 'gpt-test', isBYOK: true, capabilities: { toolCalling: true, imageInput: false },
    })]);
  });

  it('converts OpenAI requests and streamed content, reasoning, and tools to VS Code parts', async () => {
    const provider = await readyProvider(openAIModel);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request, callbacks) => {
      expect(request).toMatchObject({
        model: 'gpt-test', stream: true, max_tokens: 16, context_window: 128_000, reasoning_effort: 'max',
        tool_choice: 'required', prompt_cache_key: expect.stringMatching(/^weavenet-/),
      });
      callbacks.onResponse?.('OpenAI', 200, 'text/event-stream');
      callbacks.onReasoning('reason');
      callbacks.onContent('answer');
      callbacks.onToolCall({ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"docs"}' } });
      callbacks.onStreamEnd?.('OpenAI', '[DONE]');
    });
    const output = progress();

    await provider.provideLanguageModelChatResponse(
      { id: 'gpt-test', maxOutputTokens: 16 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required, modelOptions: { reasoningEffort: 'max', contextWindow: '128000' } } as never,
      output as never,
      token,
    );

    expect(stream).toHaveBeenCalledOnce();
    expect(output.report.mock.calls.map(([part]) => part)).toEqual([
      expect.objectContaining({ value: 'reason' }),
      expect.objectContaining({ value: 'answer' }),
      expect.objectContaining({ callId: 'call-1', name: 'search', input: { q: 'docs' } }),
    ]);
  });

  it('uses Claude native payloads, extended thinking, and native tool-choice semantics', async () => {
    const provider = await readyProvider(claudeModel, { temperature: 2, topP: 0.5 });
    const stream = vi.spyOn(RelayClient.prototype, 'streamClaudeMessages').mockImplementation(async (request, callbacks) => {
      expect(request).toMatchObject({
        model: 'claude-test', max_tokens: 9_000, stream: true,
        thinking: { type: 'enabled', budget_tokens: 7_976 },
        temperature: undefined, top_p: undefined,
      });
      expect(request.tool_choice).toBeUndefined();
      callbacks.onContent('answer');
      callbacks.onToolCall({ id: 'toolu-1', type: 'function', function: { name: 'search', arguments: '{}' } });
      callbacks.onStreamEnd?.('Claude', 'message_stop');
    });
    const output = progress();

    await provider.provideLanguageModelChatResponse(
      { id: 'claude-test', maxOutputTokens: 9_000 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required, modelOptions: { reasoningEffort: 'max' } } as never,
      output as never,
      token,
    );

    expect(stream).toHaveBeenCalledOnce();
    expect(output.report).toHaveBeenCalledTimes(2);
  });

  it('uses multimodal-compatible OpenAI payloads without Relay routing hints', async () => {
    const provider = await readyProvider(openAIModel, { supportsImageInput: true });
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request, callbacks) => {
      expect(request).toMatchObject({ model: 'gpt-test', stream: true });
      expect(request).not.toHaveProperty('max_tokens');
      expect(request).not.toHaveProperty('context_window');
      expect(request).not.toHaveProperty('reasoning_effort');
      expect(request).not.toHaveProperty('prompt_cache_key');
      callbacks.onContent('image answer');
    });

    await provider.provideLanguageModelChatResponse(
      { id: 'gpt-test', maxOutputTokens: 32 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')] }] as never,
      { modelOptions: { reasoningEffort: 'max', contextWindow: '128000' } } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('uses Claude forced tool choice when extended thinking is disabled', async () => {
    const provider = await readyProvider(claudeModel);
    const stream = vi.spyOn(RelayClient.prototype, 'streamClaudeMessages').mockImplementation(async (request) => {
      expect(request).toMatchObject({ tool_choice: { type: 'any' }, temperature: undefined, top_p: undefined });
    });

    await provider.provideLanguageModelChatResponse(
      { id: 'claude-test', maxOutputTokens: 32 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('rejects stale, unknown, and unauthenticated response requests safely', async () => {
    const { provider } = providerFixture();
    await expect(provider.provideLanguageModelChatResponse({ id: 'missing' } as never, [], {} as never, progress() as never, token))
      .rejects.toThrow('active Relay connection changed');

    const providerWithKey = await readyProvider(openAIModel);
    await expect(providerWithKey.provideLanguageModelChatResponse({ id: 'missing' } as never, [], {} as never, progress() as never, token))
      .rejects.toThrow('Unknown WeaveNet model route');

    const { provider: noKey } = providerFixture();
    (noKey as never as { cachedModels: unknown[]; cacheConnectionKey: string }).cachedModels = [openAIModel];
    (noKey as never as { cachedModels: unknown[]; cacheConnectionKey: string }).cacheConnectionKey = JSON.stringify({
      profileName: 'work', baseUrl: 'https://work.example.test/v1', requestHeaders: {}, includeModels: [], excludeModels: [], models: [],
    });
    await expect(noKey.provideLanguageModelChatResponse({ id: 'gpt-test' } as never, [], {} as never, progress() as never, token))
      .rejects.toThrow('API key is not configured');
  });

  it('maps cancellation and Relay failures to VS Code language-model errors', async () => {
    const provider = await readyProvider(openAIModel);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockRejectedValue(new RelayRequestError('denied', 401, 'json'));
    await expect(provider.provideLanguageModelChatResponse({ id: 'gpt-test' } as never, [], {} as never, progress() as never, token))
      .rejects.toMatchObject({ code: 'NoPermissions' });
    stream.mockRejectedValueOnce(new Error('cancelled'));
    await expect(provider.provideLanguageModelChatResponse({ id: 'gpt-test' } as never, [], {} as never, progress() as never, { isCancellationRequested: true } as never))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });
});