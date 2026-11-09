'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadOfficialAgentHost, responseFromParts, parseSseFrames, DEFAULT_CACHE } = require('./agentHostContract.cjs');
const token = { isCancellationRequested: false };
const vendor = 'weavenet';
const model = 'fixture-model';

// No credentials, extension activation or live model requests are needed.
const official = loadOfficialAgentHost();

test('real handler and Responses wire round trip reasoning, options, tools and vision', async () => {
  const api = await official;
  const opaque = 'weavenet-replay:v1:synthetic-opaque-state';
  let secondRequest;
  const first = api.createHandler({ sendChatRequest: async (_id, _from, messages, options) => {
    assert.equal(messages[0].role, api.ChatMessageRole.User);
    assert.deepEqual(options, {
      modelOptions: { temperature: 0.3, top_p: 0.8, max_tokens: 1234 },
      configuration: { reasoningEffort: 'high' }, includeEncryptedThinking: true,
      tools: [{ name: 'search', description: '', inputSchema: { type: 'object' } }],
    });
    return responseFromParts([
      { type: 'thinking', id: 'rs_unique', value: 'summary', metadata: { encrypted_content: opaque, arbitrary: 'not-carried' } },
      { type: 'text', value: 'Checking.' },
      { type: 'tool_use', toolCallId: 'call_1', name: 'search', parameters: { q: 'docs' } },
    ]);
  } });
  const request = api.responsesRequestToBridge(vendor, { model, input: 'question',
    reasoning: { effort: 'high' }, temperature: 0.3, top_p: 0.8, max_output_tokens: 1234,
    tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
  });
  const result = await first.chat(request, token);
  assert.equal(result.error, undefined);
  const body = JSON.parse(api.bridgeResultToResponsesBody(result, model));
  const events = parseSseFrames(api.bridgeResultToResponsesSseFrames(result, model));
  const completed = events.at(-1).response;
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(completed.output[0].encrypted_content, opaque);
  assert.equal(body.output[0].encrypted_content, opaque);
  assert.equal(Object.hasOwn(body.output[0], 'metadata'), false, 'Arbitrary bridge metadata does not survive the official wire.');
  assert.deepEqual(completed.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  const second = api.createHandler({ sendChatRequest: async (_id, _from, messages) => {
    secondRequest = messages;
    return responseFromParts([{ type: 'text', value: 'Done.' }]);
  } });
  const next = api.responsesRequestToBridge(vendor, { model, input: [
    ...completed.output,
    { type: 'function_call_output', call_id: 'call_1', output: [
      { type: 'input_text', text: 'Result' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
    ] },
  ] });
  assert.equal((await second.chat(next, token)).error, undefined);
  const thinking = secondRequest.flatMap(message => message.content).find(part => part.type === 'thinking');
  assert.deepEqual(thinking.metadata, { encrypted_content: opaque });
  assert.deepEqual(thinking.value, ['summary']);
  const tool = secondRequest.flatMap(message => message.content).find(part => part.type === 'tool_use');
  assert.deepEqual(tool.parameters, { q: 'docs' });
  const toolResult = secondRequest.flatMap(message => message.content).find(part => part.type === 'tool_result');
  assert.equal(toolResult.value[1].mimeType, 'image/png');
  assert.deepEqual([...toolResult.value[1].data], [1, 2, 3]);
});

test('official usage drops cache fields and derives totals only from input plus output', async () => {
  const api = await official;
  const handler = api.createHandler({ sendChatRequest: async () => responseFromParts([
    { type: 'text', value: 'Answer' },
    { type: 'data', mimeType: 'usage', data: Buffer.from(JSON.stringify({
      prompt_tokens: 100, completion_tokens: 10, total_tokens: 999,
      prompt_tokens_details: { cached_tokens: 75 }, cache_read_input_tokens: 75, cache_creation_input_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 4 },
    })) },
  ]) });
  const result = await handler.chat(api.responsesRequestToBridge(vendor, { model, input: 'question' }), token);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10, reasoningTokens: 4 });
  const body = JSON.parse(api.bridgeResultToResponsesBody(result, model));
  assert.deepEqual(body.usage, { input_tokens: 100, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 110 });
});

test('upstream limitation: bridge cannot signal incomplete; provider must reject instead', async () => {
  const api = await official;
  const fakeStatus = { output: [{ type: 'message', content: [{ type: 'text', text: 'Partial' }] }],
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const body = JSON.parse(api.bridgeResultToResponsesBody(fakeStatus, model));
  assert.equal(body.status, 'completed');
  assert.equal(body.incomplete_details, null);
  assert.equal(parseSseFrames(api.bridgeResultToResponsesSseFrames(fakeStatus, model)).at(-1).type, 'response.completed');
  const handler = api.createHandler({ sendChatRequest: async () => responseFromParts([
    { type: 'text', value: 'Partial' },
  ], Promise.resolve().then(() => { throw new Error('Provider response was truncated'); })) });
  const result = await handler.chat(api.responsesRequestToBridge(vendor, { model, input: 'question' }), token);
  assert.deepEqual(result, { output: [], error: 'Provider response was truncated' });
  // The real handler discards partial output on error. Do not synthesize an
  // incomplete wire status that the pinned upstream cannot actually produce.
});

test('offline cache remains fail-closed for absent and modified pinned sources', async () => {
  await official;
  const root = path.resolve(DEFAULT_CACHE, '../contract-negative-tests');
  await fs.mkdir(root, { recursive: true });
  try {
    await assert.rejects(loadOfficialAgentHost({ cacheDir: root, offline: true }), /not cached/);
    for (const name of ['byokResponsesTranslation', 'agentHostByokLmHandler']) {
      await fs.writeFile(path.join(root, `${name}.ts`), '// changed contract');
    }
    await assert.rejects(loadOfficialAgentHost({ cacheDir: root, offline: true }), /integrity mismatch/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
