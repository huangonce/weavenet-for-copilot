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
  toClaudeThinking,
  toLanguageModelError,
  WeaveNetChatProvider,
} from '../../src/copilot/provider';
import { RELAY_API_KEY_SECRET } from '../../src/constants';
import { RelayRequestError, RelayStreamError } from '../../src/relay/errors';
import { RelayTimeoutError } from '../../src/relay/http';
import { RelayClient } from '../../src/relay/client';
import { formatLogError } from '../../src/copilot/requestDiagnostics';
import { InMemoryMemento } from '../support/memento';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_ID = '22222222-2222-4222-8222-222222222222';
const WORK_PROFILE = { id: WORK_ID, name: 'work', baseUrl: 'https://work.example.test/v1' };
const PERSONAL_PROFILE = { id: PERSONAL_ID, name: 'personal', baseUrl: 'https://personal.example.test/v1' };

class InMemorySecrets {
  readonly values = new Map<string, string>();
  notificationsEnabled = true;
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
    if (!this.notificationsEnabled) return;
    for (const listener of this.listeners) listener({ key });
  }
}

function providerFixture(options: {
  profiles?: Array<{ id: string; name: string; baseUrl: string; requestHeaders?: Record<string, string> }>;
  configValues?: Record<string, unknown>;
  secrets?: InMemorySecrets;
  keys?: Record<string, string>;
} = {}): {
  provider: WeaveNetChatProvider;
  secrets: InMemorySecrets;
  setProfiles(value: typeof options.profiles): void;
} {
  let profiles = options.profiles ?? [WORK_PROFILE];
  const configValues = options.configValues ?? {};
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: <T>(key: string) => configValues[key] as T | undefined,
    inspect: <T>(key: string) => key === 'profiles'
      ? { globalValue: profiles as T }
      : undefined,
  } as never);
  const secrets = options.secrets ?? new InMemorySecrets();
  for (const [profileId, value] of Object.entries(options.keys ?? {})) secrets.values.set(keyFor(profileId), value);
  secrets.notificationsEnabled = false;
  const provider = new WeaveNetChatProvider({ secrets, globalState: new InMemoryMemento(), subscriptions: [] } as never);
  secrets.notificationsEnabled = true;
  return { provider, secrets, setProfiles: (value) => { profiles = value ?? []; } };
}

function keyFor(profileId: string): string {
  return `${RELAY_API_KEY_SECRET}.profileId.${profileId}`;
}

function relayModelRequestCount(fetchMock: ReturnType<typeof vi.spyOn>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('.example.test')).length;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe('connection pool model refresh', () => {
  it('aggregates models from every configured connection and namespaces duplicate IDs', async () => {
    const { provider } = providerFixture({
      profiles: [WORK_PROFILE, PERSONAL_PROFILE],
      keys: { [WORK_ID]: 'work-key', [PERSONAL_ID]: 'personal-key' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-test' }] }),
      { headers: { 'content-type': 'application/json' } },
    ));

    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);

    expect(relayModelRequestCount(fetchMock)).toBe(2);
    expect(information).toHaveLength(2);
    expect(new Set(information.map((model) => model.id)).size).toBe(2);
    expect(information.map((model) => model.id)).toEqual(expect.arrayContaining([
      `weavenet::${WORK_ID}::gpt-test`,
      `weavenet::${PERSONAL_ID}::gpt-test`,
    ]));
    expect(information.map((model) => model.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining('work (work.example.test)'),
      expect.stringContaining('personal (personal.example.test)'),
    ]));
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'ready', connectionCount: 2, modelCount: 2 });
  });

  it('coalesces duplicate refreshes and reuses a resolved aggregate catalog', async () => {
    const { provider } = providerFixture({
      profiles: [WORK_PROFILE, PERSONAL_PROFILE],
      keys: { [WORK_ID]: 'work-key', [PERSONAL_ID]: 'personal-key' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [] }),
      { headers: { 'content-type': 'application/json' } },
    ));

    await Promise.all([provider.refreshModels(), provider.refreshModels()]);
    await provider.refreshModels();
    await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);

    expect(relayModelRequestCount(fetchMock)).toBe(2);
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'ready', connectionCount: 2, modelCount: 0 });
  });

  it('keeps background discovery quiet and emits one aggregate explicit-refresh summary', async () => {
    const { provider, secrets } = providerFixture({ profiles: [WORK_PROFILE, PERSONAL_PROFILE] });
    secrets.values.set(keyFor(WORK_ID), 'work-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const information = vi.spyOn(vscode.window, 'showInformationMessage');

    await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);
    expect(information).not.toHaveBeenCalled();

    await provider.refreshModels('invalidate', true);
    expect(information).toHaveBeenCalledOnce();
    expect(information).toHaveBeenCalledWith('WeaveNet loaded 1 model(s) from 0/2 connection(s); 2 warning(s).');
  });

  it('reloads every resolved connection when explicitly invalidated', async () => {
    const { provider } = providerFixture({
      profiles: [WORK_PROFILE, PERSONAL_PROFILE],
      keys: { [WORK_ID]: 'work-key', [PERSONAL_ID]: 'personal-key' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-test' }] }),
      { headers: { 'content-type': 'application/json' } },
    ));

    await provider.refreshModels();
    await provider.refreshModels('invalidate');

    expect(relayModelRequestCount(fetchMock)).toBe(4);
  });

  it('does not commit an old model result after that connection key is deleted in flight', async () => {
    const { provider, secrets } = providerFixture();
    const key = keyFor(WORK_ID);
    secrets.values.set(key, 'work-key');
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));

    const refresh = provider.refreshModels();
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledOnce();
    const deletion = secrets.delete(key);
    resolveResponse?.(new Response(JSON.stringify({ data: [{ id: 'stale-model' }] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.all([refresh, deletion]);

    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'keyMissing', connectionCount: 1, modelCount: 0 });
    expect(provider.getConnectionStatus().connections[0]).toMatchObject({ phase: 'keyMissing', connectionName: 'work' });
  });

  it('isolates a failed connection without clearing healthy connection models', async () => {
    const { provider, secrets } = providerFixture({ profiles: [WORK_PROFILE, PERSONAL_PROFILE] });
    secrets.values.set(keyFor(WORK_ID), 'work-key');
    secrets.values.set(keyFor(PERSONAL_ID), 'personal-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('personal.example.test')) throw new TypeError('offline');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-work' }] }), { headers: { 'content-type': 'application/json' } });
    });

    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);

    expect(information).toHaveLength(1);
    expect(information[0].version).toBe('gpt-work');
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'degraded', modelCount: 1, warningCount: 1 });
    expect(provider.getConnectionStatus().connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionName: 'work', phase: 'ready', modelCount: 1 }),
      expect.objectContaining({ connectionName: 'personal', phase: 'error', modelCount: 0 }),
    ]));
  });

  it('retains a previous connection catalog when its next refresh fails', async () => {
    const { provider } = providerFixture({ keys: { [WORK_ID]: 'work-key' } });
    let relayCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!String(input).includes('.example.test')) {
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      relayCalls++;
      if (relayCalls >= 2) throw new TypeError('offline');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-work' }] }), { headers: { 'content-type': 'application/json' } });
    });

    await provider.refreshModels();
    await provider.refreshModels('invalidate');
    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);

    expect(relayModelRequestCount(fetchMock)).toBe(3);
    expect(information).toHaveLength(1);
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'degraded', modelCount: 1, warningCount: 1 });
  });

  it('limits aggregate model refreshes to three concurrent connections', async () => {
    const profiles = Array.from({ length: 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `relay-${index + 1}`,
      baseUrl: `https://relay-${index + 1}.example.test/v1`,
    }));
    const { provider, secrets } = providerFixture({ profiles });
    for (const profile of profiles) secrets.values.set(keyFor(profile.id), `key-${profile.name}`);
    let active = 0;
    let maximum = 0;
    const resolvers: Array<() => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active--;
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    });

    const refresh = provider.refreshModels();
    await flushAsyncWork();
    expect(maximum).toBe(3);
    for (let completed = 0; completed < profiles.length;) {
      while (resolvers.length === 0) await flushAsyncWork();
      completed += resolvers.length;
      resolvers.splice(0).forEach((resolve) => resolve());
      await flushAsyncWork();
    }
    await refresh;

    expect(maximum).toBe(3);
  });

  it('isolates SecretStorage read failures to the affected connection', async () => {
    class ReadFailingSecrets extends InMemorySecrets {
      override async get(key: string): Promise<string | undefined> {
        if (key === keyFor(PERSONAL_ID)) throw new Error('secret read failed');
        return super.get(key);
      }
    }
    const secrets = new ReadFailingSecrets();
    secrets.values.set(keyFor(WORK_ID), 'work-key');
    const { provider } = providerFixture({ profiles: [WORK_PROFILE, PERSONAL_PROFILE], secrets });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-work' }] }), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(provider.refreshModels()).resolves.toBeUndefined();

    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'degraded', modelCount: 1, warningCount: 1 });
    expect(provider.getConnectionStatus().connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionName: 'personal', phase: 'error', message: expect.stringContaining('Could not read the API key') }),
    ]));
  });

  it('keeps Picker models available when a later API key status read fails', async () => {
    class ToggleFailingSecrets extends InMemorySecrets {
      failProfileId?: string;
      override async get(key: string): Promise<string | undefined> {
        if (key === this.failProfileId) throw new Error('secret status read failed');
        return super.get(key);
      }
    }
    const secrets = new ToggleFailingSecrets();
    secrets.values.set(keyFor(WORK_ID), 'work-key');
    secrets.values.set(keyFor(PERSONAL_ID), 'personal-key');
    const { provider } = providerFixture({ profiles: [WORK_PROFILE, PERSONAL_PROFILE], secrets });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-test' }] }),
      { headers: { 'content-type': 'application/json' } },
    ));
    await provider.refreshModels();
    secrets.failProfileId = keyFor(PERSONAL_ID);

    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, {} as never);

    expect(information).toHaveLength(2);
    expect(information.find((model) => model.id.includes(WORK_ID))).toMatchObject({
      detail: expect.stringContaining('work (work.example.test)'),
    });
    expect(information.find((model) => model.id.includes(PERSONAL_ID))).toMatchObject({
      detail: 'API key required',
      statusIcon: expect.objectContaining({ id: 'warning' }),
    });
  });

  it('returns model diagnostics while treating a failed optional Claude probe as a warning', async () => {
    const { provider, secrets } = providerFixture();
    secrets.values.set(keyFor(WORK_ID), 'work-key');
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

    await expect(provider.testConnection(WORK_PROFILE)).resolves.toMatchObject({
      profileId: WORK_ID,
      connectionName: 'work',
      host: 'work.example.test',
      modelCount: 2,
      overall: 'degraded',
      probes: expect.arrayContaining([
        expect.objectContaining({ probe: 'models', verdict: 'supported', requestId: 'models-request' }),
        expect.objectContaining({ probe: 'claude.nonStreaming', verdict: 'indeterminate' }),
      ]),
    });
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'error', modelCount: 0 });
  });

  it('reports invalid URLs and missing keys with structured connection failures', async () => {
    const { provider } = providerFixture();

    await expect(provider.testConnection({ ...WORK_PROFILE, baseUrl: 'ftp://relay.example.test' })).rejects.toMatchObject({
      failure: { category: 'url' },
    });
    await expect(provider.testConnection(WORK_PROFILE)).rejects.toMatchObject({
      failure: { category: 'authentication' },
    });
    expect(provider.getConnectionStatus()).toMatchObject({ phase: 'keyMissing', connectionCount: 1, modelCount: 0 });
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
    expect(getConfiguredReasoningEffort({
      ...thinkingModel,
      openai: { reasoningEfforts: ['minimal', 'low'], defaultReasoningEffort: 'minimal' },
    }, { modelOptions: { reasoningEffort: 'high' } } as never)).toBe('minimal');
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
    try { parseToolArguments('{'); }
    catch (error) { expect(formatLogError(error)).toBe('InvalidToolArgumentsError(reason=malformed-json, length=1)'); }
    try { parseToolArguments('[]'); }
    catch (error) { expect(formatLogError(error)).toBe('InvalidToolArgumentsError(reason=non-object, length=2)'); }
    expect(estimateTextTokens('你好abcd')).toBe(3);
    expect(estimateTextTokens('')).toBe(1);
  });
});

describe('Provider chat responses', () => {
  const token = { isCancellationRequested: false } as never;
  const progress = () => ({ report: vi.fn() });
  const openAIModel = { id: 'gpt-test', capabilities: { tool_calling: true, reasoning: true }, context_length: 128_000 };
  const claudeModel = { id: 'claude-test', capabilities: { tool_calling: true, reasoning: true } };

  async function readyProvider(
    model: typeof openAIModel | typeof claudeModel,
    configValues: Record<string, unknown> = {},
    profile = WORK_PROFILE,
  ) {
    const { provider, secrets } = providerFixture({
      profiles: [profile],
      configValues: {
        sendMaxTokens: true,
        supportsToolCalling: true,
        openaiPromptCaching: true,
        ...configValues,
      },
    });
    secrets.values.set(keyFor(profile.id), `${profile.name}-key`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [model] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await provider.refreshModels();
    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, token);
    return { provider, model: information[0] };
  }

  it('provides refreshed picker information with connection key state', async () => {
    const { provider } = await readyProvider(openAIModel);
    const information = await provider.provideLanguageModelChatInformation({} as never, token);
    expect(information).toEqual([expect.objectContaining({
      id: `weavenet::${WORK_ID}::gpt-test`, isBYOK: true, capabilities: { toolCalling: true, imageInput: false },
    })]);
  });

  it('converts OpenAI requests and streamed content, reasoning, and tools to VS Code parts', async () => {
    const profile = {
      ...WORK_PROFILE,
      models: [{ id: 'gpt-test', route: 'openai' as const, toolCalling: true, thinking: true }],
    };
    const { provider, model } = await readyProvider(openAIModel, {}, profile);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request, callbacks) => {
      expect(request).toMatchObject({
        model: 'gpt-test', stream: true, max_tokens: 16, reasoning_effort: 'max',
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
      { ...model, maxOutputTokens: 16 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required, modelOptions: { reasoningEffort: 'max' } } as never,
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

  it('uses explicitly supported modern OpenAI request fields without changing legacy defaults', async () => {
    const profile = {
      ...WORK_PROFILE,
      models: [{
        id: 'gpt-test', route: 'openai' as const, toolCalling: true, thinking: true,
        contextWindows: [128_000],
        openai: {
          tokenLimitField: 'max_completion_tokens' as const,
          contextWindow: true,
          promptCacheKey: true,
          store: true,
          strictTools: true,
          parallelToolCalls: true,
          developerRole: true,
          reasoningEfforts: ['minimal', 'high'] as const,
          defaultReasoningEffort: 'minimal' as const,
        },
      }],
    };
    const { provider, model } = await readyProvider(openAIModel, { temperature: 0.4, topP: 0.7 }, profile);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request) => {
      expect(request).toMatchObject({
        max_completion_tokens: 32,
        context_window: 128_000,
        reasoning_effort: 'minimal',
        store: false,
        parallel_tool_calls: true,
        temperature: 0.4,
        top_p: undefined,
      });
      expect(request).not.toHaveProperty('max_tokens');
      expect(request.tools?.[0].function).toMatchObject({ strict: true });
      expect(request.messages[0].role).toBe('developer');
    });

    await provider.provideLanguageModelChatResponse(
      { ...model, maxOutputTokens: 32 } as never,
      [{ role: 3, content: [new vscode.LanguageModelTextPart('instructions')] }] as never,
      {
        tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {}, required: [] } }],
        modelOptions: { reasoningEffort: 'unsupported', contextWindow: '128000' },
      } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('does not enable strict tools for schemas with optional properties', async () => {
    const profile = {
      ...WORK_PROFILE,
      models: [{
        id: 'gpt-test', route: 'openai' as const, toolCalling: true,
        openai: { strictTools: true },
      }],
    };
    const { provider, model } = await readyProvider(openAIModel, {}, profile);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request) => {
      expect(request.tools?.[0].function).not.toHaveProperty('strict');
      expect(request.tools?.[0].function.parameters).toEqual({
        type: 'object', properties: { query: { type: 'string' } },
      });
    });

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      { tools: [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('uses Claude native payloads, extended thinking, and native tool-choice semantics', async () => {
    const { provider, model } = await readyProvider(claudeModel, { temperature: 2, topP: 0.5 });
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
      { ...model, maxOutputTokens: 9_000 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required, modelOptions: { reasoningEffort: 'max' } } as never,
      output as never,
      token,
    );

    expect(stream).toHaveBeenCalledOnce();
    expect(output.report).toHaveBeenCalledTimes(2);
  });

  it('uses multimodal-compatible OpenAI payloads without Relay routing hints', async () => {
    const { provider, model } = await readyProvider(openAIModel, { supportsImageInput: true });
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async (request, callbacks) => {
      expect(request).toMatchObject({ model: 'gpt-test', stream: true });
      expect(request).not.toHaveProperty('max_tokens');
      expect(request).not.toHaveProperty('context_window');
      expect(request).not.toHaveProperty('reasoning_effort');
      expect(request).not.toHaveProperty('prompt_cache_key');
      callbacks.onContent('image answer');
    });

    await provider.provideLanguageModelChatResponse(
      { ...model, maxOutputTokens: 32 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')] }] as never,
      { modelOptions: { reasoningEffort: 'max', contextWindow: '128000' } } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('uses Claude forced tool choice when extended thinking is disabled', async () => {
    const { provider, model } = await readyProvider(claudeModel);
    const stream = vi.spyOn(RelayClient.prototype, 'streamClaudeMessages').mockImplementation(async (request) => {
      expect(request).toMatchObject({ tool_choice: { type: 'any' }, temperature: undefined, top_p: undefined });
    });

    await provider.provideLanguageModelChatResponse(
      { ...model, maxOutputTokens: 32 } as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      { tools: [{ name: 'search', description: 'Search', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required } as never,
      progress() as never,
      token,
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it('rejects stale and unknown response requests safely', async () => {
    const { provider } = providerFixture();
    await expect(provider.provideLanguageModelChatResponse({ id: 'missing' } as never, [], {} as never, progress() as never, token))
      .rejects.toThrow('Unknown WeaveNet model route');

    const { provider: providerWithKey } = await readyProvider(openAIModel);
    await expect(providerWithKey.provideLanguageModelChatResponse({ id: 'missing' } as never, [], {} as never, progress() as never, token))
      .rejects.toThrow('Unknown WeaveNet model route');
  });

  it('routes duplicate model IDs through the selected model source URL, headers, and key', async () => {
    const work = { ...WORK_PROFILE, requestHeaders: { 'x-relay': 'work' } };
    const personal = { ...PERSONAL_PROFILE, requestHeaders: { 'x-relay': 'personal' } };
    const { provider } = providerFixture({
      profiles: [work, personal],
      configValues: { sendMaxTokens: true },
      keys: { [WORK_ID]: 'work-key', [PERSONAL_ID]: 'personal-key' },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ data: [openAIModel] }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const information = await provider.provideLanguageModelChatInformation({ silent: true } as never, token);
    const selected = information.find((model) => model.id.includes(PERSONAL_ID));
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockImplementation(async function (request) {
      expect(request.model).toBe('gpt-test');
      expect(this).toMatchObject({
        options: {
          baseUrl: 'https://personal.example.test/v1',
          apiKey: 'personal-key',
          requestHeaders: { 'x-relay': 'personal' },
        },
      });
    });

    await provider.provideLanguageModelChatResponse(
      selected as never,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] }] as never,
      {} as never,
      progress() as never,
      token,
    );

    expect(stream).toHaveBeenCalledOnce();
  });

  it('invalidates old model bindings after a connection configuration revision', async () => {
    const { provider, secrets, setProfiles } = providerFixture();
    secrets.values.set(keyFor(WORK_ID), 'work-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [openAIModel] }), {
      headers: { 'content-type': 'application/json' },
    }));
    const [oldModel] = await provider.provideLanguageModelChatInformation({ silent: true } as never, token);

    setProfiles([{ ...WORK_PROFILE, baseUrl: 'https://new-work.example.test/v1' }]);
    await provider.refreshModels();

    await expect(provider.provideLanguageModelChatResponse(oldModel, [], {} as never, progress() as never, token))
      .rejects.toThrow('Unknown WeaveNet model route');
  });

  it('maps cancellation and Relay failures to VS Code language-model errors', async () => {
    const { provider, model } = await readyProvider(openAIModel);
    const stream = vi.spyOn(RelayClient.prototype, 'streamChatCompletion').mockRejectedValue(new RelayRequestError('denied', 401, 'json'));
    await expect(provider.provideLanguageModelChatResponse(model, [], {} as never, progress() as never, token))
      .rejects.toMatchObject({ code: 'NoPermissions' });
    stream.mockRejectedValueOnce(new Error('cancelled'));
    await expect(provider.provideLanguageModelChatResponse(model, [], {} as never, progress() as never, { isCancellationRequested: true } as never))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });
});