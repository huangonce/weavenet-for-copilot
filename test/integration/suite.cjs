const assert = require('node:assert/strict');
const vscode = require('vscode');

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

  const commands = await vscode.commands.getCommands(true);
  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `Command ${command} was not registered.`);
  }
}

module.exports = { run };
