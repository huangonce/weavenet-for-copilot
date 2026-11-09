'use strict';

// Runs the real MIT-licensed VS Code translation and renderer handler, not a
// protocol replica. Only service/DI and byte-buffer dependencies are substituted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const COMMIT = 'c4453f8ea430795f941c1b2ff6c9321135a74a02';
const SOURCE_FILES = Object.freeze({
  byokResponsesTranslation: {
    path: 'src/vs/platform/agentHost/node/copilot/byokResponsesTranslation.ts',
    sha256: '9ca74c0f5d6c405ae894af80c783416948d9d4c6e46b95189b781a939190294e',
  },
  agentHostByokLmHandler: {
    path: 'src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostByokLmHandler.ts',
    sha256: 'f8e8fa3ac8e7896490d0d1ba9cfe624a7cfc9d9c9518e8b92e00aad129ce6961',
  },
});
const DEFAULT_CACHE = path.resolve(__dirname, '../../.tmp/agent-host-contract', COMMIT);
const ChatMessageRole = Object.freeze({ System: 0, User: 1, Assistant: 2 });
const ChatImageMimeType = Object.freeze({ PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WEBP: 'image/webp', BMP: 'image/bmp' });

async function sourceFile(name, options) {
  const spec = SOURCE_FILES[name];
  const filename = path.join(options.cacheDir ?? DEFAULT_CACHE, `${name}.ts`);
  let source;
  try {
    source = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (options.offline || process.env.WEAVENET_AGENT_HOST_OFFLINE === '1') {
      throw new Error(`Pinned Agent Host source is not cached: ${filename}. Run npm run test:agent-host once online.`);
    }
    const url = `https://raw.githubusercontent.com/microsoft/vscode/${COMMIT}/${spec.path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot download pinned Agent Host source (${response.status}): ${url}`);
    source = await response.text();
    verifySource(name, source);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, source, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    // Validate a concurrently created cache rather than trusting it.
    source = await fs.readFile(filename, 'utf8');
  }
  verifySource(name, source);
  return source;
}

function verifySource(name, source) {
  const actual = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(actual, SOURCE_FILES[name].sha256, `Pinned official source integrity mismatch: ${name}; remove/restore the corrupt cache, do not silently change the contract.`);
}

function evaluate(name, source, imports) {
  const compiled = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  });
  const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: value => value, getCurrentDirectory: () => __dirname, getNewLine: () => '\n',
  }));
  const mod = { exports: {} };
  // Execute in this realm so DTO prototypes and Error instanceof checks are real.
  const run = vm.runInThisContext(`(function(require,module,exports){${compiled.outputText}\n})`, { filename: `official/${COMMIT}/${name}.js` });
  run(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unstubbed official runtime dependency: ${specifier}`);
    return imports[specifier];
  }, mod, mod.exports);
  return mod.exports;
}

function bufferServices() {
  return {
    decodeBase64: value => {
      // VS Code's decoder rejects invalid alphabet characters, unlike Buffer.from.
      if (typeof value !== 'string' || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid base64');
      return Buffer.from(value, 'base64');
    },
    VSBuffer: { fromString: value => Buffer.from(value, 'utf8') },
  };
}

async function loadOfficialAgentHost(options = {}) {
  const [translationSource, handlerSource] = await Promise.all([
    sourceFile('byokResponsesTranslation', options), sourceFile('agentHostByokLmHandler', options),
  ]);
  const translation = evaluate('byokResponsesTranslation', translationSource, {
    '../../../../base/common/buffer.js': bufferServices(),
  });
  const decorator = () => {};
  const { AgentHostByokLmHandler } = evaluate('agentHostByokLmHandler', handlerSource, {
    '../../../../../../base/common/lifecycle.js': { Disposable: class {} },
    '../../../../../../base/common/event.js': {},
    '../../../../../../base/common/buffer.js': bufferServices(),
    '../../../../../../platform/agentHost/common/agentHostByokLm.js': {},
    '../../../../../../platform/contextkey/common/contextkey.js': { IContextKeyService: decorator },
    '../../../../../../platform/log/common/log.js': { ILogService: decorator },
    '../../../../../services/chat/common/chatEntitlementService.js': {
      IChatEntitlementService: decorator, ChatEntitlementContextKeys: { clientByokEnabled: { key: 'clientByokEnabled' } },
    },
    '../../../common/languageModels.js': { ILanguageModelsService: decorator, ChatMessageRole, ChatImageMimeType },
    '../../../common/chatSessionsService.js': {},
  });
  for (const name of ['responsesRequestToBridge', 'bridgeResultToResponsesBody', 'bridgeResultToResponsesSseFrames']) {
    assert.equal(typeof translation[name], 'function', `Official contract export missing: ${name}`);
  }
  for (const name of ['chat', '_toChatMessages', '_encodeReasoningMetadata', '_decodeReasoningMetadata', '_decodeUsage']) {
    assert.equal(typeof AgentHostByokLmHandler.prototype[name], 'function', `Official handler method missing: ${name}`);
  }

  function createHandler({ sendChatRequest, vendor = 'weavenet', modelId = 'fixture-model', warn = () => {} } = {}) {
    assert.equal(typeof sendChatRequest, 'function', 'A synthetic model callback is required; no model/network service is supplied.');
    // Bypass constructor subscription/DI wiring only. Every chat, metadata,
    // message, usage and option conversion runs the original unmodified methods.
    const handler = Object.create(AgentHostByokLmHandler.prototype);
    handler._chatEntitlementService = { clientByokEnabled: true };
    handler._logService = { warn };
    handler._languageModelsService = {
      lookupLanguageModel: identifier => identifier === `${vendor}/${modelId}` ? { isBYOK: true, vendor, id: modelId } : undefined,
      getLanguageModelIds: () => [`${vendor}/${modelId}`],
      sendChatRequest,
    };
    return handler;
  }
  return { ...translation, createHandler, ChatMessageRole, ChatImageMimeType, commit: COMMIT };
}

function responseFromParts(parts, result = Promise.resolve()) {
  return {
    stream: (async function* () { yield* parts; })(),
    result,
  };
}

function parseSseFrames(frames) {
  return frames.map(frame => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    assert.ok(event && data, 'Official SSE frame must contain event and data.');
    const value = JSON.parse(data);
    assert.equal(value.type, event);
    return value;
  });
}

module.exports = { COMMIT, SOURCE_FILES, DEFAULT_CACHE, loadOfficialAgentHost, responseFromParts, parseSseFrames };
