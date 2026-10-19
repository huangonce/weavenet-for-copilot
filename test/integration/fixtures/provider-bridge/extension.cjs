const vscode = require('vscode');

function activate(context) {
  return {
    register(provider) {
      const registration = vscode.lm.registerLanguageModelChatProvider('weavenet-regression', provider);
      context.subscriptions.push(registration);
      return registration;
    },
  };
}

module.exports = { activate };
