// Local CPU benchmarks only: no Relay requests, credentials, or timing gates.
// Pass an alternate compiled out directory to compare an earlier build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const compiledRoot = path.resolve(process.argv[2] || path.join(root, 'out'));
const mockPath = path.join(root, 'test/support/vscode.mock.ts');
const mock = new Module(mockPath);
mock.filename = mockPath;
mock.paths = Module._nodeModulePaths(path.dirname(mockPath));
mock._compile(ts.transpileModule(fs.readFileSync(mockPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 },
}).outputText, mockPath);

const originalLoad = Module._load;
let metadata, cache, chat, helpers, prefixes;
try {
  Module._load = function (name, parent, isMain) {
    return name === 'vscode' ? mock.exports : originalLoad.call(this, name, parent, isMain);
  };
  metadata = require(path.join(compiledRoot, 'metadata/openrouterFallback.js'));
  cache = require(path.join(compiledRoot, 'metadata/metadataCache.js'));
  chat = require(path.join(compiledRoot, 'relay/openai.js'));
  helpers = require(path.join(compiledRoot, 'copilot/helpers.js'));
  prefixes = require(path.join(compiledRoot, 'copilot/claudePrefix.js'));
} finally {
  Module._load = originalLoad;
}

const stored = new Map();
cache.initMetadataCache({ globalState: { get: key => stored.get(key) }, subscriptions: [] });
const cases = [];

function measure(name, workload, operation, verify, rounds = 7, batch = 1) {
  for (let index = 0; index < 2; index++) verify(operation());
  global.gc?.();
  const samples = [];
  for (let index = 0; index < rounds; index++) {
    let result;
    const start = performance.now();
    for (let iteration = 0; iteration < batch; iteration++) result = operation();
    samples.push((performance.now() - start) / batch);
    verify(result);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  cases.push({ name, workload, rounds, batch, medianMs: sorted[Math.floor(rounds / 2)],
    minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: samples });
}

for (const [count, size, bareOnly] of [[500, 1_000, false], [2_000, 10_000, true]]) {
  const entries = Array.from({ length: size }, (_, index) => ({
    id: `model-${index}`, fullId: `vendor/model-${index}`, contextWindow: 128_000 + index, toolCalling: true,
  }));
  stored.set(metadata.OPENROUTER_CACHE_KEY, { data: entries, fetchedAt: Date.now() });
  const models = Array.from({ length: count }, (_, index) => {
    const id = `${bareOnly || index % 2 ? '' : 'vendor/'}model-${(index * 17) % size}`;
    return { id, upstreamId: id, pickerId: id, apiType: 'chat-completions', catalogSource: 'discovery' };
  });
  measure(`metadata-${count}x${size}`, { models: count, catalogEntries: size, bareOnly },
    () => metadata.enrichModelsWithOpenRouter(models), result => {
      assert.equal(result.length, count);
      result.forEach((model, index) => {
        assert.equal(model.contextWindow, 128_000 + (index * 17) % size);
        assert.equal(model.toolCalling, true);
      });
    });
}

function toolCase(name, content, fragmentUnits, batch = 1) {
  const argumentsValue = JSON.stringify({ content });
  const lines = [];
  for (let offset = 0; offset < argumentsValue.length; offset += fragmentUnits) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
      ...(offset === 0 ? { id: 'call', function: { name: 'write_file', arguments: argumentsValue.slice(offset, offset + fragmentUnits) } }
        : { function: { arguments: argumentsValue.slice(offset, offset + fragmentUnits) } }),
    }] } }] })}`);
  }
  lines.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  measure(name, { argumentBytes: Buffer.byteLength(argumentsValue), fragments: lines.length - 1, fragmentUnits }, () => {
    let emitted;
    const pending = new Map();
    const state = { responseParts: 0, started: false, sawFinishReason: false };
    const callbacks = { onContent() {}, onReasoning() {}, onToolCall(call) { emitted = call; } };
    for (const line of lines) chat.processOpenAISseLine(line, pending, callbacks, state);
    return emitted;
  }, call => {
    assert.equal(call.id, 'call');
    assert.equal(call.function.arguments, argumentsValue);
  }, 5, batch);
}
toolCase('tool-small', 'x'.repeat(256), 64, 100);
toolCase('tool-ascii-1MiB', 'x'.repeat(1024 * 1024), 128);
toolCase('tool-cjk-1MiB', '汉'.repeat(Math.floor(1024 * 1024 / 3)), 128);

for (const [name, value] of [
  ['ascii', 'const value = 42;\n'.repeat(16_384)],
  ['mixed', 'Hello 世界 かな 한글 😀\n'.repeat(8_192)],
]) {
  const expected = helpers.estimateTextTokens(value);
  measure(`token-count-${name}`, { utf8Bytes: Buffer.byteLength(value), estimatedTokens: expected },
    () => helpers.estimateTextTokens(value), result => assert.equal(result, expected));
}

for (const turns of [32, 128, 256]) {
  const request = { system: [{ type: 'text', text: 'Stable system' }], messages: [] };
  const snapshot = { messages: [] };
  for (let index = 0; index < turns; index++) {
    request.messages.push({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4096) }] });
    const prefix = prefixes.claudePrefix(request);
    const blocks = [{ type: 'thinking', thinking: 'thought', signature: `signature-${index}` }, { type: 'text', text: 'reply' }];
    request.messages.push({ role: 'assistant', content: blocks });
    snapshot.messages.push({ content: [{ kind: 'thinking', protocolReplay: {
      version: 1, apiType: 'messages', identity: 'same', displayText: 'reply', claude: blocks, claudePrefix: prefix,
    } }] });
  }
  measure(`claude-prefix-${turns}-turns`, { turns, wireBytes: Buffer.byteLength(JSON.stringify(request)) },
    () => prefixes.validateClaudePrefixes(snapshot, request, 'same'), result => assert.equal(result, undefined));
}

const sourceHashes = Object.fromEntries(['metadata/openrouterFallback.js', 'relay/openai.js', 'copilot/helpers.js', 'copilot/claudePrefix.js'].map(file =>
  [file, createHash('sha256').update(fs.readFileSync(path.join(compiledRoot, file))).digest('hex')]));
process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, warmups: 2, compiledRoot, sourceHashes, cases }, null, 2) + '\n');
