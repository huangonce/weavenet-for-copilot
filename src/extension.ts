import * as vscode from 'vscode';
import { VENDOR } from './constants';
import { WeaveNetChatProvider } from './copilot/provider';
import { getConfig, migrateLegacyBaseUrl } from './config/config';
import { initMetadataCache, onMetadataChanged } from './metadata/metadataCache';
import { scheduleOpenRouterRefresh } from './metadata/openrouterFallback';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const migratedBaseUrl = await migrateLegacyBaseUrl();
  const provider = new WeaveNetChatProvider(context);
  initMetadataCache(context, (message) => provider.logMetadata(message));

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    onMetadataChanged(() => provider.refreshModelPicker()),
    vscode.commands.registerCommand('weavenet-copilot.setOpenAIKey', () => provider.configureOpenAIKey()),
    vscode.commands.registerCommand('weavenet-copilot.setChatGPTKey', () => provider.configureChatGPTKey()),
    vscode.commands.registerCommand('weavenet-copilot.setClaudeKey', () => provider.configureClaudeKey()),
    vscode.commands.registerCommand('weavenet-copilot.clearOpenAIKey', () => provider.clearOpenAIKey()),
    vscode.commands.registerCommand('weavenet-copilot.clearChatGPTKey', () => provider.clearChatGPTKey()),
    vscode.commands.registerCommand('weavenet-copilot.clearClaudeKey', () => provider.clearClaudeKey()),
    vscode.commands.registerCommand('weavenet-copilot.refreshModels', () => provider.refreshModels()),
    vscode.commands.registerCommand('weavenet-copilot.refreshModelMetadata', async () => {
      const refreshHours = getConfig().metadataRefreshHours;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'WeaveNet: Refreshing model metadata',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Fetching OpenRouter catalog' });
          await (scheduleOpenRouterRefresh(refreshHours * 3_600_000, true) ?? Promise.resolve());
          await provider.refreshModels();
        },
      );
    }),
    vscode.commands.registerCommand('weavenet-copilot.showDebugLog', () => provider.showDebugLog()),
    vscode.commands.registerCommand('weavenet-copilot.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'weavenet-copilot'),
    ),
  );

  await vscode.extensions.getExtension('github.copilot-chat')?.activate();
  if (migratedBaseUrl) {
    void vscode.window.showInformationMessage(
      'WeaveNet API endpoint was updated to the Hong Kong gateway for improved connectivity.',
    );
  }
  void provider.refreshModels().catch(() => undefined);
}

export function deactivate(): void {}
