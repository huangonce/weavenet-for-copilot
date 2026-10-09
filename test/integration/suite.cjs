const assert = require('node:assert/strict');
const vscode = require('vscode');
const http = require('node:http');
const path = require('node:path');

const extensionId = 'huangonce.weavenet-for-copilot';
const expectedCommands = [
  'weavenet-copilot.manageConnections',
  'weavenet-copilot.refreshModels',
  'weavenet-copilot.setRelayKey',
  'weavenet-copilot.testConnection',
];

async function run() {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Extension ${extensionId} was not discovered.`);

  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension did not activate.');

  const provider = extension.packageJSON.contributes.languageModelChatProviders.find(entry => entry.vendor === 'weavenet');
  assert.equal(provider.managementCommand, 'weavenet-copilot.manageConnections', 'Provider management entry is missing.');
  const properties = extension.packageJSON.contributes.configuration.properties;
  assert.equal(properties['weavenet-copilot.openaiApiStrategy'], undefined, 'Retired global API strategy is still exposed.');
  assert.deepEqual(properties['weavenet-copilot.profiles'].items.properties.apiType.enum, ['chat-completions', 'responses', 'messages']);
  const models = require(path.join(extension.extensionPath, 'out', 'relay', 'models.js'));
  const { getConfig } = require(path.join(extension.extensionPath, 'out', 'config', 'config.js'));
  const information = models.toChatInformation(models.toRoutedModel({ id: 'smoke', context_length: 8192, max_completion_tokens: 4096 }, 'chat-completions'), getConfig(), true);
  assert.equal(information.maxInputTokens, 4096, 'Shared context window must reserve output tokens.');
  assert.equal(information.maxOutputTokens, 4096);
  const { assembleModelCatalog } = require(path.join(extension.extensionPath, 'out', 'copilot', 'modelRegistry.js'));
  const { ModelSnapshotStore } = require(path.join(extension.extensionPath, 'out', 'copilot', 'modelSnapshotStore.js'));
  const profileId = '11111111-1111-4111-8111-111111111111';
  const revision = 'a'.repeat(64);
  const config = { ...getConfig({ id: profileId, name: 'Smoke', baseUrl: 'https://relay.example.test/v1', apiType: 'messages',
    models: [{ id: 'shared', apiType: 'responses', toolCalling: true }, { id: 'shared' }, { id: 'fixed' }] }), modelMetadataEnabled: false };
  const directory = ['messages', 'responses'].map(apiType => models.toRoutedModel({ id: 'shared', context_length: 8192 }, apiType));
  const values = new Map();
  const state = { get: key => values.get(key), keys: () => [...values.keys()], update: async (key, value) => {
    if (value === undefined) values.delete(key); else values.set(key, value);
  } };
  const store = new ModelSnapshotStore(state);
  await store.update(profileId, revision, directory);
  const record = store.get(profileId, revision);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.directory.length, 2);
  assert.equal(record.models, undefined);
  assert.equal(record.snapshots, undefined);
  const assembled = assembleModelCatalog(config, record.directory);
  assert.deepEqual(assembled.map(model => [model.upstreamId, model.apiType, model.pickerId]), [
    ['fixed', 'messages', 'fixed'], ['shared', 'messages', 'shared::messages'], ['shared', 'responses', 'shared::responses'],
  ]);
  assert.equal(assembled[2].toolCalling, true);
  assert.deepEqual(assembled, assembleModelCatalog(config, directory), 'Offline assembly must match online assembly.');
  await store.clear();
  const legacyModels = [{ id: 'legacy', upstreamId: 'legacy', pickerId: 'legacy', protocol: 'openai', route: 'openai', openaiApi: 'responses' }];
  values.set(`weavenet-copilot.modelSnapshots.v2.${profileId}.${revision}`, {
    schemaVersion: 2, profileId, catalogRevision: revision, savedAt: Date.now(), models: legacyModels,
    snapshots: { openai: legacyModels, chatgpt: [], claude: [] },
  });
  const upgraded = store.get(profileId, revision);
  assert.equal(upgraded.directory[0].apiType, 'responses');
  assert.equal(upgraded.directory[0].protocol, undefined);
  assert.equal(upgraded.directory[0].route, undefined);
  assert.equal(upgraded.directory[0].openaiApi, undefined);
  await store.deleteProfile(profileId);
  assert.equal(values.size, 0, 'Queued legacy upgrades must not resurrect deleted directories.');
  if (typeof vscode.LanguageModelThinkingPart === 'function') {
    const { snapshotChatRequest } = require(path.join(extension.extensionPath, 'out', 'copilot', 'canonicalRequest.js'));
    const snapshot = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelThinkingPart(['first', ' second'])], name: undefined }]);
    assert.equal(snapshot.messages[0].content[0].value, 'first second', 'Host array thinking must be accepted.');
    const identity = 'a'.repeat(64);
    const replay = { version: 1, identity, apiType: 'messages', displayText: 'answer', claude: [
      { type: 'thinking', thinking: 'signed thought', signature: 'opaque-signature' },
      { type: 'redacted_thinking', data: 'opaque-redacted-data' }, { type: 'text', text: 'answer' },
    ] };
    const carried = new vscode.LanguageModelThinkingPart('', undefined, { weavenetProtocolReplay: replay });
    const restored = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelTextPart('answer'), carried], name: undefined }]);
    const { convertClaudeMessages, convertResponsesInput } = require(path.join(extension.extensionPath, 'out', 'copilot', 'convert.js'));
    const nativeContent = convertClaudeMessages(restored, { supportsImageInput: false, protocolIdentity: identity }).messages[0].content;
    assert.deepEqual(JSON.parse(JSON.stringify(nativeContent)), replay.claude);
    const phase = { version: 1, identity, apiType: 'responses', displayText: 'intermediate', responses: [
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'intermediate' }] },
    ] };
    const phaseSnapshot = snapshotChatRequest([{ role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new vscode.LanguageModelTextPart('intermediate'), new vscode.LanguageModelThinkingPart('', undefined, { weavenetProtocolReplay: phase })], name: undefined }]);
    assert.equal(convertResponsesInput(phaseSnapshot, false, false, true, false, identity).input[0].phase, 'commentary');
  }
  const commands = await vscode.commands.getCommands(true);
  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `Command ${command} was not registered.`);
  }

  await checkHostProviderContract(extension, profileId);

  await checkUnknownSnapshotSchemaIgnored(profileId);

  await checkLiveRequestPaths(extension);
}

/**
 * Exercises the provider through the real host and directly through the compiled
 * module. The smoke host has no credentials, so this asserts fail-closed
 * degradation instead of a live model exchange.
 */
async function checkHostProviderContract(extension, profileId) {
  const configuration = vscode.workspace.getConfiguration('weavenet-copilot');
  const previousProfiles = configuration.inspect('profiles')?.globalValue ?? [];
  await configuration.update('profiles', [{
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Smoke',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiType: 'chat-completions',
  }], vscode.ConfigurationTarget.Global);
  try {
    const discovered = await vscode.lm.selectChatModels({ vendor: 'weavenet' });
    assert.ok(Array.isArray(discovered), 'Host model enumeration must resolve.');
    assert.equal(discovered.length, 0, 'An unreachable relay without a key must not publish models.');
    assert.equal((await vscode.lm.selectChatModels({ vendor: 'weavenet' })).length, 0, 'Enumeration must stay stable.');
  } finally {
    await configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global);
  }

  const { WeaveNetChatProvider } = require(path.join(extension.extensionPath, 'out', 'copilot', 'provider.js'));
  const { context } = createHostContext();
  const direct = new WeaveNetChatProvider(context);
  const source = new vscode.CancellationTokenSource();
  try {
    const information = await direct.provideLanguageModelChatInformation({ silent: true }, source.token);
    assert.ok(Array.isArray(information), 'provideLanguageModelChatInformation must resolve through the host contract.');
    const counted = await direct.provideTokenCount({ id: 'smoke-model' }, 'hello world', source.token);
    assert.ok(Number.isInteger(counted) && counted > 0, 'provideTokenCount must return a positive token count.');
  } finally {
    source.dispose();
    for (const disposable of context.subscriptions) disposable?.dispose?.();
  }
}

/** The compiled snapshot store must ignore an unknown schema version. */
async function checkUnknownSnapshotSchemaIgnored(profileId) {
  const { ModelSnapshotStore } = require(path.join(__dirname, '..', '..', 'out', 'copilot', 'modelSnapshotStore.js'));
  const stored = new Map([[`weavenet-copilot.modelSnapshots.v3.${profileId}.${'b'.repeat(64)}`, {
    schemaVersion: 4, profileId, catalogRevision: 'b'.repeat(64), savedAt: Date.now(), directory: [],
  }]]);
  const store = new ModelSnapshotStore({ get: (key) => stored.get(key), keys: () => [...stored.keys()], update: async () => undefined });
  assert.equal(store.get(profileId, 'b'.repeat(64)), undefined, 'Unknown snapshot schema versions must be ignored.');
}

/** Minimal ExtensionContext stand-in backed by in-memory secrets and global state. */
function createHostContext(secretEntries = []) {
  const secrets = new Map(secretEntries);
  const state = new Map();
  return {
    secrets,
    context: {
      subscriptions: [],
      secrets: {
        get: async (key) => secrets.get(key),
        store: async (key, value) => { secrets.set(key, value); },
        delete: async (key) => { secrets.delete(key); },
        onDidChange: () => ({ dispose: () => undefined }),
      },
      globalState: {
        get: (key) => state.get(key),
        keys: () => [...state.keys()],
        update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value); },
      },
    },
  };
}

const MOCK_DIRECTORY = {
  data: [
    { id: 'mock-chat', context_length: 16384, max_completion_tokens: 8192, capabilities: { tool_calling: true } },
    { id: 'mock-claude', context_length: 16384, max_completion_tokens: 8192,
      capabilities: { tool_calling: true, reasoning: true, claude: { thinkingMode: 'manual', sampling: true, forcedToolChoice: true } } },
    { id: 'mock-responses', context_length: 16384, max_completion_tokens: 8192, capabilities: { tool_calling: true, reasoning: true } },
  ],
};

const sseBody = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');

const MOCK_SSE = {
  '/v1/chat/completions': sseBody([
    { choices: [{ delta: { content: 'mock answer' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_live', type: 'function',
      function: { name: 'search', arguments: JSON.stringify({ q: 'docs' }) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]) + 'data: [DONE]\n\n',
  '/v1/messages': sseBody([
    { type: 'message_start', message: { id: 'msg_live', usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mock thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'mock answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]),
  '/v1/responses': sseBody([
    { type: 'response.created', response: { id: 'resp_live' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'mock answer' },
    { type: 'response.completed', response: { id: 'resp_live', status: 'completed', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
  ]),
};

/** Loopback relay used by the live request check; every call is recorded for assertions. */
function handleMockRelay(request, response, recorded) {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    recorded.push({ method: request.method, path: pathname, headers: request.headers, raw, body });
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      const payload = JSON.stringify(MOCK_DIRECTORY);
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }
    const stream = request.method === 'POST' ? MOCK_SSE[pathname] : undefined;
    if (stream !== undefined) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(stream);
      return;
    }
    const payload = JSON.stringify({ error: { message: `Unexpected mock relay request: ${request.method} ${pathname}` } });
    response.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    response.end(payload);
  });
}

/**
 * Drives real streaming requests through a loopback mock relay. The smoke host
 * has no credentials, so the provider is built directly with in-memory secrets;
 * every byte still travels the real fetch/SSE pipeline, and Claude replay is
 * asserted on the parts the provider hands back to the host.
 */
async function checkLiveRequestPaths(extension) {
  const { RELAY_API_KEY_SECRET } = require(path.join(extension.extensionPath, 'out', 'constants.js'));
  const { WeaveNetChatProvider } = require(path.join(extension.extensionPath, 'out', 'copilot', 'provider.js'));
  const configuration = vscode.workspace.getConfiguration('weavenet-copilot');
  const previousProfiles = configuration.inspect('profiles')?.globalValue ?? [];
  const recorded = [];
  const server = http.createServer((request, response) => handleMockRelay(request, response, recorded));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const profiles = [
    { id: '44444444-4444-4444-8444-444444444444', name: 'Live chat', baseUrl, apiType: 'chat-completions', includeModels: ['^mock-chat$'] },
    { id: '55555555-5555-4555-8555-555555555555', name: 'Live messages', baseUrl, apiType: 'messages', includeModels: ['^mock-claude$'] },
    { id: '66666666-6666-4666-8666-666666666666', name: 'Live responses', baseUrl, apiType: 'responses', includeModels: ['^mock-responses$'] },
  ];
  await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
  const entries = profiles.map(profile => [`${RELAY_API_KEY_SECRET}.profileId.${profile.id}`, 'live-key']);
  const { context, secrets } = createHostContext(entries);
  const provider = new WeaveNetChatProvider(context);
  const source = new vscode.CancellationTokenSource();
  try {
    const info = await provider.provideLanguageModelChatInformation({ silent: true }, source.token);
    const discoveredIds = info.map(model => model.id).sort();
    const catalogReport = `received=[${discoveredIds.join(', ')}] relay=[${recorded.map(entry => `${entry.method} ${entry.path}`).join(', ')}]`;
    assert.equal(discoveredIds.length, 3, `The relay directory was not discovered through provideLanguageModelChatInformation. ${catalogReport}`);
    const modelFor = suffix => {
      const matches = info.filter(entry => entry.id.endsWith(`::${suffix}`));
      assert.equal(matches.length, 1, `Model ${suffix} was not discovered exactly once. ${catalogReport}`);
      return matches[0];
    };
    for (const suffix of ['mock-chat', 'mock-claude', 'mock-responses']) {
      assert.ok(modelFor(suffix).id.startsWith('weavenet::'), `Catalog ids must be qualified by vendor and connection. ${catalogReport}`);
    }
    const tool = { name: 'search', description: 'Search the documentation',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
    const collect = async (model, messages, options = {}) => {
      const parts = [];
      await provider.provideLanguageModelChatResponse(model, messages, options, { report: part => parts.push(part) }, source.token);
      return parts;
    };
    const textParts = parts => parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value);
    const requestTo = pathname => {
      const match = recorded.filter(entry => entry.path === pathname);
      return match;
    };

    const chatParts = await collect(modelFor('mock-chat'), [vscode.LanguageModelChatMessage.User('hello')], { tools: [tool] });
    assert.deepEqual(textParts(chatParts), ['mock answer'], 'Chat Completions text was not streamed to the host.');
    const toolCall = chatParts.find(part => part instanceof vscode.LanguageModelToolCallPart);
    assert.ok(toolCall, 'The streamed Chat Completions tool call was not published.');
    assert.equal(toolCall.name, 'search');
    assert.deepEqual(typeof toolCall.input === 'string' ? JSON.parse(toolCall.input) : toolCall.input, { q: 'docs' });
    const [chatRequest] = requestTo('/v1/chat/completions');
    assert.ok(chatRequest, 'The Chat Completions endpoint was never reached.');
    assert.equal(chatRequest.body.model, 'mock-chat');
    assert.equal(chatRequest.body.stream, true);
    assert.equal(chatRequest.headers.authorization, 'Bearer live-key');
    assert.deepEqual(chatRequest.body.messages.map(message => message.role), ['user']);
    assert.equal(chatRequest.body.tools[0].function.name, 'search');

    const claudeParts = await collect(modelFor('mock-claude'), [vscode.LanguageModelChatMessage.User('hello')], { tools: [tool] });
    assert.deepEqual(textParts(claudeParts), ['mock answer'], 'Claude text was not streamed to the host.');
    const signed = claudeParts.find(part => part.metadata?.weavenetProtocolReplay);
    assert.ok(signed, 'Claude signed thinking state was not attached to a thinking part.');
    const replay = signed.metadata.weavenetProtocolReplay;
    assert.equal(replay.version, 1);
    assert.equal(replay.apiType, 'messages');
    assert.deepEqual(replay.claude[0], { type: 'thinking', thinking: 'mock thought', signature: 'mock-signature' });
    const [claudeRequest] = requestTo('/v1/messages');
    assert.ok(claudeRequest, 'The Messages endpoint was never reached.');
    assert.equal(claudeRequest.headers['x-api-key'], 'live-key');
    assert.ok(claudeRequest.headers['anthropic-version'], 'The Messages request must declare an anthropic-version.');
    assert.ok(claudeRequest.body.thinking, 'Manual Claude thinking must request a thinking budget.');

    await collect(modelFor('mock-claude'), [
      vscode.LanguageModelChatMessage.User('hello'),
      vscode.LanguageModelChatMessage.Assistant(claudeParts),
      vscode.LanguageModelChatMessage.User('second'),
    ], { tools: [tool] });
    const [, continuation] = requestTo('/v1/messages');
    assert.ok(continuation, 'The continuation request was never sent.');
    const replayedBlocks = continuation.body.messages.at(-2).content;
    assert.deepEqual(replayedBlocks.map(block => block.type), ['thinking', 'text'],
      'The replayed Claude turn must resend the signed thinking block before the text block.');
    assert.equal(replayedBlocks[0].thinking, 'mock thought');
    assert.equal(replayedBlocks[0].signature, 'mock-signature');
    assert.equal(replayedBlocks[1].text, 'mock answer');

    let prefixFailure;
    try {
      await collect(modelFor('mock-claude'), [
        vscode.LanguageModelChatMessage.User('different first turn'),
        vscode.LanguageModelChatMessage.Assistant(claudeParts),
        vscode.LanguageModelChatMessage.User('second'),
      ], { tools: [tool] });
    } catch (error) {
      prefixFailure = error;
    }
    assert.ok(prefixFailure, 'A changed prefix must not replay signed thinking.');
    assert.match(String(prefixFailure.message), /Start a new conversation/);
    assert.equal(requestTo('/v1/messages').length, 2, 'An invalid signature must never be sent to the relay.');

    const responsesParts = await collect(modelFor('mock-responses'), [vscode.LanguageModelChatMessage.User('hello')]);
    assert.deepEqual(textParts(responsesParts), ['mock answer'], 'Responses text was not streamed to the host.');
    const [responsesRequest] = requestTo('/v1/responses');
    assert.ok(responsesRequest, 'The Responses endpoint was never reached.');
    assert.equal(responsesRequest.body.model, 'mock-responses');
    assert.equal(responsesRequest.body.stream, true);

    secrets.delete(entries[0][0]);
    let failure;
    try {
      await collect(modelFor('mock-chat'), [vscode.LanguageModelChatMessage.User('hello')]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'A request without an API key must fail closed.');
    assert.match(String(failure.message), /not configured/, `Unexpected fail-closed error: ${failure.message}`);
    assert.equal(requestTo('/v1/chat/completions').length, 1, 'A key-less request must not reach the relay.');
  } finally {
    source.dispose();
    for (const disposable of context.subscriptions) disposable?.dispose?.();
    await new Promise(resolve => server.close(resolve));
    await configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global);
  }
}

module.exports = { run };
