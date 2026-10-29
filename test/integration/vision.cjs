const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

// A generated 1x1 RGBA PNG with valid chunk CRCs. The real host decodes images
// before the request reaches our synthetic vision backend.
const IMAGE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

/** Real host RPC for the main provider; only the secondary vision backend is synthetic. */
async function checkVisionReplayRequests({ extension, provider, recorded, profiles }) {
  const bridgeExtension = vscode.extensions.getExtension('weavenet-tests.provider-bridge');
  assert.ok(bridgeExtension, 'The vision replay regression requires the provider RPC bridge.');
  const bridge = await bridgeExtension.activate();
  assert.equal(typeof vscode.LanguageModelThinkingPart, 'function', 'The test host must support metadata carriers.');
  const vision = require(path.join(extension.extensionPath, 'out', 'copilot', 'visionProxy.js'));
  const selectVisionDescriber = vision.selectVisionDescriber;
  const configuration = vscode.workspace.getConfiguration('weavenet-copilot');
  const settings = ['profiles', 'visionProxyEnabled', 'visionProxyModel'];
  const previous = new Map(settings.map(key => [key, configuration.inspect(key)?.globalValue]));
  const source = new vscode.CancellationTokenSource();
  const caption = 'The screenshot contains a Settings button at the upper right.';
  const question = 'Read the button label and explain where it is.';
  let descriptions = 0;
  let selections = 0;
  let registration;
  const mockVision = {
    identity: { vendor: 'synthetic-vision', id: 'mock-vision' },
    async describe(request) {
      descriptions++;
      assert.equal(request.images.length, 1);
      assert.equal(request.images[0].mimeType, 'image/png');
      assert.match(request.prompt, /Read the button label/);
      assert.ok(request.maxTokens > 0 && request.maxTokens <= 1024, 'Vision output must use the request caption budget.');
      assert.equal(request.token.isCancellationRequested, false);
      return caption;
    },
  };
  try {
    vision.selectVisionDescriber = async configured => {
      selections++;
      assert.equal(configured, 'synthetic-vision/mock-vision');
      return mockVision;
    };
    await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
    await configuration.update('visionProxyEnabled', true, vscode.ConfigurationTarget.Global);
    await configuration.update('visionProxyModel', 'synthetic-vision/mock-vision', vscode.ConfigurationTarget.Global);
    await provider.refreshModels('invalidate');
    registration = bridge.register(provider);
    const available = await vscode.lm.selectChatModels({ vendor: 'weavenet-regression' });
    const model = available.find(item => item.version === 'mock-claude');
    assert.ok(model, 'The text-only Claude fixture must be discoverable through RPC.');
    const firstUser = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart(question),
      new vscode.LanguageModelDataPart(new Uint8Array(IMAGE_PNG), 'image/png'),
    ]);
    const send = async (stage, messages) => {
      const start = recorded.length;
      const parts = [];
      let phase = 'request';
      try {
        const response = await model.sendRequest(messages, { modelOptions: { reasoningEffort: 'low' } }, source.token);
        phase = 'stream';
        for await (const part of response.stream) parts.push(part);
        phase = 'assertions';
        const posts = recorded.slice(start).filter(entry => entry.method === 'POST');
        assert.equal(posts.length, 1, 'Each main-model RPC turn must reach the loopback relay exactly once.');
        assert.equal(posts[0].path, '/v1/messages');
        assert.equal(parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join(''), 'mock answer');
        return { parts, request: posts[0].body };
      } catch (error) {
        // Never serialize request bodies, image bytes, headers or arbitrary host
        // error objects; DOM events otherwise appear only as [object Object].
        const field = key => {
          const value = error?.[key];
          return typeof value === 'string' ? value.slice(0, 400) : typeof value === 'boolean' ? value : undefined;
        };
        throw new Error(`Vision RPC regression failed: ${JSON.stringify({ stage, phase, host: vscode.version,
          error: { name: field('name'), message: field('message'), code: field('code'), type: field('type'), isTrusted: field('isTrusted') },
          expectedEndpoint: '/v1/messages', requests: recorded.slice(start).map(entry => [entry.method, entry.path]),
          selections, descriptions, parts: parts.length,
          visionCarriers: parts.filter(part => part.metadata?.weavenetVisionReplay).length,
          protocolCarriers: parts.filter(part => part.metadata?.weavenetProtocolReplay).length,
        })}`);
      }
    };

    const first = await send('first', [firstUser]);
    const carrier = first.parts.find(part => part.metadata?.weavenetVisionReplay);
    assert.ok(carrier instanceof vscode.LanguageModelThinkingPart, 'Vision metadata must survive the provider-to-client RPC.');
    assert.ok(carrier.value === '' || Array.isArray(carrier.value) && carrier.value.every(value => value === ''),
      'The vision carrier must not add visible assistant text.');
    const replay = carrier.metadata.weavenetVisionReplay;
    assert.match(replay.identity, /^[a-f0-9]{64}$/);
    assert.equal(replay.entries.length, 1);
    assert.match(replay.entries[0].key, /^[a-f0-9]{64}$/);
    assert.ok(replay.entries[0].text.includes(caption));
    const signed = first.parts.find(part => part.metadata?.weavenetProtocolReplay)?.metadata.weavenetProtocolReplay;
    assert.ok(signed?.claudePrefix?.hash, 'Native signed protocol state must remain independent of vision replay.');
    assert.equal(selections, 1);
    assert.equal(descriptions, 1);

    // Model the cache loss caused by expiry or an Extension Host cache reset.
    provider.visionDescriptionCache.clear();
    assert.equal(provider.visionDescriptionCache.entryCount, 0);
    const second = await send('continuation', [
      firstUser,
      vscode.LanguageModelChatMessage.Assistant(first.parts),
      vscode.LanguageModelChatMessage.User('Use the screenshot evidence from the previous turn.'),
    ]);
    assert.equal(descriptions, 1, 'Host-carried evidence must survive cache loss without another vision call.');
    assert.equal(selections, 1, 'A historical replay hit must not select the vision backend again.');
    assert.deepEqual(second.request.messages[0], first.request.messages[0], 'Historical caption bytes must keep the signed request prefix stable.');
    assert.deepEqual(second.request.messages[1].content.filter(block => block.type === 'thinking'),
      signed.claude.filter(block => block.type === 'thinking'), 'The original Claude thinking signature must survive the combined RPC replay.');
    const wire = JSON.stringify(second.request);
    assert.ok(wire.includes(caption));
    assert.ok(!wire.includes('original image was not replayed'));
    assert.ok(!wire.includes('weavenetVisionReplay'), 'Metadata keys must not be serialized into model content.');
    assert.ok(!wire.includes('data:image/') && !wire.includes('"type":"image"'), 'The text-only target must never receive original image data.');
  } finally {
    registration?.dispose();
    source.dispose();
    vision.selectVisionDescriber = selectVisionDescriber;
    provider.visionDescriptionCache.clear();
    for (const key of settings) await configuration.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
  }
}

module.exports = { checkVisionReplayRequests };
