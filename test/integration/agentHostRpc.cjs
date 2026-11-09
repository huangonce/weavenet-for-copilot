'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const { loadOfficialAgentHost, parseSseFrames } = require('./agentHostContract.cjs');

// These adapters cross only the public extension API/internal LM DTO boundary.
// All Responses, reasoning-metadata and history translation is official code.
function toPublicPart(part) {
  switch (part.type) {
    case 'text': return new vscode.LanguageModelTextPart(part.value);
    case 'thinking': return new vscode.LanguageModelThinkingPart(part.value, part.id, part.metadata);
    case 'tool_use': return new vscode.LanguageModelToolCallPart(part.toolCallId, part.name, part.parameters);
    case 'tool_result': return new vscode.LanguageModelToolResultPart(part.toolCallId, part.value.map(toPublicPart));
    case 'image_url': return vscode.LanguageModelDataPart.image(Buffer.from(part.value.data), part.value.mimeType);
    case 'data': return new vscode.LanguageModelDataPart(Buffer.from(part.data), part.mimeType);
    default: throw new Error(`Unsupported official LM input DTO ${part.type}`);
  }
}

function toInternalPart(part) {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', value: part.value };
  if (part instanceof vscode.LanguageModelThinkingPart) return { type: 'thinking', value: part.value, id: part.id, metadata: part.metadata };
  if (part instanceof vscode.LanguageModelToolCallPart) return { type: 'tool_use', toolCallId: part.callId, name: part.name,
    parameters: typeof part.input === 'string' ? JSON.parse(part.input) : part.input };
  if (part instanceof vscode.LanguageModelDataPart) return { type: 'data', mimeType: part.mimeType, data: Buffer.from(part.data) };
  throw new Error(`Unsupported provider output part ${part.constructor.name}`);
}

function createRegisteredModelHandler({ official, model, token, calls = [] }) {
  return official.createHandler({ modelId: model.version, sendChatRequest: async (_identifier, _from, messages, options) => {
    calls.push({ messages, options });
    const publicMessages = messages.map(message => {
      assert.notEqual(message.role, official.ChatMessageRole.System, 'This fixture does not request proposed system-role API.');
      const content = message.content.map(toPublicPart);
      return message.role === official.ChatMessageRole.Assistant
        ? vscode.LanguageModelChatMessage.Assistant(content) : vscode.LanguageModelChatMessage.User(content);
    });
    // The real host RPC, not this adapter, maps configuration to modelConfiguration.
    const response = await model.sendRequest(publicMessages, options, token);
    return { stream: (async function* () {
      for await (const part of response.stream) yield toInternalPart(part);
    })(), result: Promise.resolve() };
  } });
}

async function checkAgentHostRegisteredRequests({ modelFor, recorded, token, tool, relayControl }) {
  const official = await loadOfficialAgentHost();
  for (const [model, endpoint, apiType] of [
    ['mock-chat', '/v1/chat/completions', 'chat-completions'],
    ['mock-responses', '/v1/responses', 'responses'],
    ['mock-claude', '/v1/messages', 'messages'],
  ]) {
    const calls = [];
    const handler = createRegisteredModelHandler({ official, model: modelFor(model), token, calls });
    const wireRequest = { model, input: [{ type: 'message', role: 'user', content: 'Official Agent Host round trip' }],
      reasoning: { effort: 'low' }, max_output_tokens: 4096, temperature: 0.3, top_p: 0.8,
      tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }],
    };
    const start = recorded.length;
    const first = await handler.chat(official.responsesRequestToBridge('weavenet', wireRequest), token);
    assert.equal(first.error, undefined, `${apiType}: ${first.error}`);
    const firstNative = recorded.slice(start).find(entry => entry.method === 'POST' && entry.path === endpoint);
    assert.ok(firstNative, `${apiType}: official handler must call real provider RPC and loopback relay.`);
    assert.equal(firstNative.body[apiType === 'responses' ? 'max_output_tokens' : 'max_tokens'], 4096,
      `${apiType}: explicit SDK output cap must reach the native request.`);
    if (apiType === 'messages') {
      assert.equal(firstNative.body.temperature, undefined, 'A model that forbids sampling must not inherit SDK values.');
    } else {
      assert.equal(firstNative.body.temperature, 0.3, 'SDK sampling must reach capable native protocols.');
    }
    assert.equal(firstNative.body.top_p, undefined, 'temperature wins when the caller supplies both sampling fields.');
    const body = JSON.parse(official.bridgeResultToResponsesBody(first, model));
    const events = parseSseFrames(official.bridgeResultToResponsesSseFrames(first, model));
    const terminal = events.at(-1).response;
    assert.equal(terminal.status, 'completed');
    assert.equal(body.output_text, 'mock answer');
    assert.equal(terminal.output_text, body.output_text);
    assert.equal(terminal.usage.input_tokens_details.cached_tokens, 0, 'Known upstream limitation: cached usage is not preserved.');
    const carrier = terminal.output.find(item => item.type === 'reasoning' && item.encrypted_content?.startsWith('weavenet-replay:v1:'));
    assert.ok(carrier, `${apiType}: real host serialization must retain the production opaque replay carrier.`);
    assert.equal(Object.hasOwn(carrier, 'metadata'), false, 'Wire replay cannot depend on arbitrary metadata.');
    const tools = terminal.output.filter(item => item.type === 'function_call');
    const input = [...wireRequest.input, ...terminal.output,
      ...tools.map(item => ({ type: 'function_call_output', call_id: item.call_id, output: 'Official tool result' })),
      ...(!tools.length ? [{ type: 'message', role: 'user', content: 'Continue' }] : []),
    ];
    const beforeNext = recorded.length;
    const second = await handler.chat(official.responsesRequestToBridge('weavenet', { ...wireRequest, input }), token);
    assert.equal(second.error, undefined, `${apiType} continuation: ${second.error}`);
    const next = recorded.slice(beforeNext).filter(entry => entry.method === 'POST' && entry.path === endpoint);
    assert.equal(next.length, 1, `${apiType}: no hidden fallback or retry.`);
    assert.equal(calls[1].options.configuration.reasoningEffort, 'low');
    const restored = calls[1].messages.flatMap(message => message.content)
      .find(part => part.type === 'thinking' && part.metadata?.encrypted_content === carrier.encrypted_content);
    assert.ok(restored, `${apiType}: official reverse handler must decode encrypted_content for the next model call.`);
    const native = next[0].body;
    assert.ok(!JSON.stringify(native).includes('weavenet-replay:v1:'), 'Opaque host carrier must not leak to native relay protocols.');
    if (apiType === 'messages') {
      const assistant = native.messages.find(message => message.role === 'assistant');
      assert.deepEqual(assistant.content.filter(block => block.type === 'thinking'),
        [{ type: 'thinking', thinking: 'mock thought', signature: 'mock-signature' }]);
      assert.equal(native.output_config.effort, 'low');
    } else if (apiType === 'responses') {
      assert.ok(native.input.some(item => item.type === 'function_call' && item.call_id === 'call_responses'));
      assert.ok(native.input.some(item => item.type === 'function_call_output' && item.output === 'Official tool result'));
      assert.equal(native.reasoning.effort, 'low');
      assert.ok(native.input.some(item => item.type === 'reasoning' && item.id === 'rs_live'
        && item.encrypted_content === 'native-encrypted-reasoning'), 'Original encrypted reasoning must survive the whole bridge.');
      assert.ok(native.input.some(item => item.type === 'message' && item.role === 'assistant' && item.phase === 'commentary'),
        'The native phase must be restored from protocol state even when the host wire omits it.');
    } else {
      const assistant = native.messages.find(message => message.role === 'assistant');
      assert.ok(assistant.tool_calls.some(call => call.id === 'call_live'));
      assert.equal(assistant.reasoning_content, 'mock chat thought', 'Chat reasoning content must survive the complete wire round trip.');
      assert.equal(native.reasoning_effort, 'low');
    }
  }
  await checkTruncatedRequests({ official, modelFor, recorded, token, relayControl });
}

async function checkTruncatedRequests({ official, modelFor, recorded, token, relayControl }) {
  const streams = [
    ['mock-chat', '/v1/chat/completions', [
      { choices: [{ delta: { content: 'Partial' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]],
    ['mock-responses', '/v1/responses', [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Partial' }] }] } },
    ]],
    ['mock-claude', '/v1/messages', [
      { type: 'message_start', message: { id: 'msg_truncated', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' },
    ]],
  ];
  try {
    for (const [model, endpoint, events] of streams) {
      relayControl.respond = (entry, response) => {
        assert.equal(entry.path, endpoint);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
          + (model === 'mock-chat' ? 'data: [DONE]\n\n' : ''));
      };
      const handler = createRegisteredModelHandler({ official, model: modelFor(model), token });
      const start = recorded.length;
      const result = await handler.chat(official.responsesRequestToBridge('weavenet', { model, input: 'Trigger output limit' }), token);
      assert.match(result.error, /truncated|not complete/iu, `${model}: truncation must become an explicit host failure.`);
      assert.deepEqual(result.output, [], 'Current upstream discards partial output on error; do not falsely claim it is retained in the SDK.');
      assert.equal(recorded.slice(start).filter(entry => entry.method === 'POST').length, 1, 'Truncation must not trigger retries.');
    }
  } finally { relayControl.respond = undefined; }
}

module.exports = { checkAgentHostRegisteredRequests, createRegisteredModelHandler, toPublicPart, toInternalPart };
