const assert = require('node:assert/strict');
const vscode = require('vscode');

const BRIDGE_ID = 'weavenet-tests.provider-bridge';
const VENDOR = 'weavenet-regression';
const MODEL_IDS = {
  'chat-completions': 'mock-chat',
  responses: 'mock-responses',
  messages: 'mock-claude',
};
const TOOL = {
  name: 'search',
  description: 'Search the documentation',
  inputSchema: { type: 'object', properties: { q: { type: 'string' },
    errorMessage: { type: 'string' }, data: { enum: [{ errorMessage: 'business value', $schema: 'literal' }] } }, required: ['q'] },
};
const OPTIONS = {
  tools: [TOOL],
  toolMode: vscode.LanguageModelChatToolMode.Auto,
  modelOptions: { reasoningEffort: 'low' },
};

function rpcProfiles(profiles) {
  return profiles.map(profile => {
    const id = MODEL_IDS[profile.apiType];
    assert.ok(id, `The RPC fixture does not define a model for ${profile.apiType}.`);
    const existing = profile.models?.find(model => model.id === id);
    const model = { ...existing, id, thinking: true, toolCalling: true };
    if (profile.apiType === 'messages') {
      model.claude = { ...existing?.claude, thinkingMode: 'adaptive', reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high', sampling: false, forcedToolChoice: false };
    } else {
      model.openai = { ...existing?.openai, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', strictTools: false };
    }
    return { ...profile, models: [...(profile.models ?? []).filter(entry => entry.id !== id), model] };
  });
}

async function readStream(response) {
  const parts = [];
  for await (const part of response.stream) parts.push(part);
  return parts;
}

function textOf(parts) {
  return parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('');
}

function replayOf(parts, apiType) {
  const carrier = parts.find(part => part?.metadata?.weavenetProtocolReplay?.apiType === apiType);
  assert.ok(carrier, `VS Code ${vscode.version} did not preserve ${apiType} protocol metadata in the RPC response stream.`);
  assert.ok(carrier instanceof vscode.LanguageModelThinkingPart,
    `VS Code ${vscode.version} returned ${apiType} protocol metadata without a thinking-part carrier.`);
  return carrier.metadata.weavenetProtocolReplay;
}

function toolOf(parts, callId, expectedInput) {
  const calls = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
  assert.equal(calls.length, 1, 'The RPC stream must contain exactly one complete tool call.');
  const call = calls[0];
  assert.equal(call.callId, callId);
  assert.equal(call.name, 'search');
  assert.deepEqual(typeof call.input === 'string' ? JSON.parse(call.input) : call.input, expectedInput);
  return call;
}

/**
 * Uses a separate fixture extension as the registration owner, so positive
 * requests traverse the real extension-host RPC boundary without changing the
 * production extension's exports or touching its SecretStorage.
 * Call after the direct-provider request-count assertions and restore the fake
 * Chat key first. The caller owns the loopback server and provider disposal.
 */
async function checkRegisteredRequests({ provider, recorded, profiles }) {
  const bridgeExtension = vscode.extensions.getExtension(BRIDGE_ID);
  assert.ok(bridgeExtension, `Missing RPC fixture extension ${BRIDGE_ID}; include its development path in the test runner.`);
  const bridge = await bridgeExtension.activate();
  assert.equal(typeof bridge?.register, 'function', 'The RPC fixture must expose register(provider).');
  assert.equal(typeof vscode.LanguageModelThinkingPart, 'function',
    `VS Code ${vscode.version} lacks the thinking-part carrier required for protocol metadata RPC regression checks.`);

  const configuration = vscode.workspace.getConfiguration('weavenet-copilot');
  const previousProfiles = configuration.inspect('profiles')?.globalValue ?? [];
  const source = new vscode.CancellationTokenSource();
  let registration;
  try {
    await configuration.update('profiles', rpcProfiles(profiles), vscode.ConfigurationTarget.Global);
    await provider.refreshModels('invalidate');
    registration = bridge.register(provider);
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
    assert.equal(models.length, 3, `VS Code ${vscode.version} did not enumerate all three registered RPC models.`);
    const modelFor = id => {
      const matches = models.filter(model => model.version === id);
      assert.equal(matches.length, 1, `RPC model ${id} must be discoverable exactly once.`);
      assert.equal(matches[0].vendor, VENDOR);
      return matches[0];
    };
    const send = async (id, path, messages) => {
      const start = recorded.length;
      const parts = await readStream(await modelFor(id).sendRequest(messages, OPTIONS, source.token));
      const requests = recorded.slice(start).filter(entry => entry.method === 'POST' && entry.path === path);
      assert.equal(requests.length, 1, `RPC request ${id} must reach its Relay endpoint exactly once.`);
      assert.equal(textOf(parts), 'mock answer', `RPC text was lost for ${id}.`);
      assert.equal(requests[0].body.model, id);
      return { parts, request: requests[0] };
    };

    const counted = await modelFor('mock-chat').countTokens('hello world', source.token);
    assert.ok(Number.isInteger(counted) && counted > 0, 'Token counting must work through the registered model RPC.');

    const chat = await send('mock-chat', '/v1/chat/completions', [vscode.LanguageModelChatMessage.User('RPC chat')]);
    toolOf(chat.parts, 'call_live', { q: 'docs 😀汉' });
    assert.equal(chat.request.body.reasoning_effort, 'low', 'Chat reasoning effort must survive the caller-to-provider RPC options.');
    assert.equal(chat.request.body.tools[0].function.name, TOOL.name);

    // Exercise the public text view on a separate response, without assuming
    // that one response's async iterables support multiple consumers.
    const textResponse = await modelFor('mock-chat').sendRequest([vscode.LanguageModelChatMessage.User('RPC text view')], OPTIONS, source.token);
    let streamedText = '';
    for await (const chunk of textResponse.text) streamedText += chunk;
    assert.equal(streamedText, 'mock answer', 'The public response.text view must deliver the streamed text.');

    const responsesFirstUser = vscode.LanguageModelChatMessage.User('RPC responses');
    const responses = await send('mock-responses', '/v1/responses', [responsesFirstUser]);
    const responsesTool = toolOf(responses.parts, 'call_responses', { q: 'response docs' });
    assert.equal(responses.request.body.reasoning?.effort, 'low', 'Responses reasoning effort must survive RPC.');
    assert.equal(responses.request.body.tools[0].strict, false, 'RPC requests must retain the explicit non-strict Responses tool schema.');
    const responsesReplay = replayOf(responses.parts, 'responses');
    assert.ok(responsesReplay.responses.some(item => item.type === 'function_call' && item.call_id === responsesTool.callId),
      'RPC metadata must retain the Responses tool call.');
    const responsesContinuation = await send('mock-responses', '/v1/responses', [
      responsesFirstUser,
      vscode.LanguageModelChatMessage.Assistant(responses.parts),
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(responsesTool.callId,
        [new vscode.LanguageModelTextPart('RPC tool result')])]),
    ]);
    assert.ok(responsesContinuation.request.body.input.some(item => item.type === 'function_call' && item.call_id === responsesTool.callId));
    assert.ok(responsesContinuation.request.body.input.some(item => item.type === 'function_call_output'
      && item.call_id === responsesTool.callId && item.output === 'RPC tool result'),
    'Responses history must survive the consumer-to-provider RPC round trip.');

    const claudeFirstUser = vscode.LanguageModelChatMessage.User('RPC signed thinking');
    const claude = await send('mock-claude', '/v1/messages', [claudeFirstUser]);
    assert.deepEqual(claude.request.body.thinking, { type: 'adaptive' });
    assert.equal(claude.request.body.output_config?.effort, 'low', 'Claude reasoning effort must survive RPC.');
    assert.equal(claude.request.body.tools[0].name, TOOL.name);
    assert.deepEqual(claude.request.body.cache_control, { type: 'ephemeral' });
    for (const schema of [chat.request.body.tools[0].function.parameters,
      responses.request.body.tools[0].parameters, claude.request.body.tools[0].input_schema]) {
      assert.deepEqual(schema, TOOL.inputSchema, 'Host RPC must preserve optional business keys and enum data.');
    }
    const claudeReplay = replayOf(claude.parts, 'messages');
    assert.deepEqual(claudeReplay.claude[0], { type: 'thinking', thinking: 'mock thought', signature: 'mock-signature' });
    assert.match(claudeReplay.claudePrefix?.hash ?? '', /^[a-f0-9]{64}$/, 'RPC must preserve the signed-prefix fingerprint.');
    const claudeContinuation = await send('mock-claude', '/v1/messages', [
      claudeFirstUser,
      vscode.LanguageModelChatMessage.Assistant(claude.parts),
      vscode.LanguageModelChatMessage.User('RPC continuation'),
    ]);
    const replayed = claudeContinuation.request.body.messages.at(-2).content;
    assert.deepEqual(replayed.filter(block => block.type === 'thinking'),
      [{ type: 'thinking', thinking: 'mock thought', signature: 'mock-signature' }],
      'The host must return the original signed thinking metadata to the provider on the next RPC request.');
    assert.equal(replayed.filter(block => block.type === 'text').map(block => block.text).join(''), 'mock answer');
  } finally {
    registration?.dispose();
    source.dispose();
    await configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global);
  }
}

module.exports = { checkRegisteredRequests };
