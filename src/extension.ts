import * as vscode from 'vscode';
import { VENDOR } from './constants';
import { WeaveNetChatProvider } from './copilot/provider';
import { registerConnectionCommands, showInitialConnectionPrompt, showLegacyResetPrompt } from './commands/connectionCommands';
import { errorMessage } from './config/connectionMutations';
import { getProfileConfiguration } from './config/config';
import { initMetadataCache, onMetadataChanged } from './metadata/metadataCache';
import { initResponsesProbeCache } from './relay/responsesProbeCache';
import { resetLegacyInstallation } from './migration/legacyReset';
import { migrateProfilePoolConfiguration } from './migration/profilePool';
import { createStatusBarItem } from './ui/statusBarPresenter';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let legacyDataRemoved = false;
  try {
    legacyDataRemoved = (await resetLegacyInstallation(context)).cleaned;
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not clear settings from the previous connection format: ${errorMessage(error)}`);
  }
  try {
    await migrateProfilePoolConfiguration();
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not upgrade Relay connections to the connection pool format: ${errorMessage(error)}`);
  }
  initResponsesProbeCache(context);
  const provider = new WeaveNetChatProvider(context);
  try {
    await provider.migrateRelayKeys(getProfileConfiguration().profiles);
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not migrate Relay API keys to stable connection identities: ${errorMessage(error)}`);
  }
  initMetadataCache(context, (message) => provider.logMetadata(message));

  context.subscriptions.push(
    createStatusBarItem(context, provider),
    registerConnectionCommands(context, provider),
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    onMetadataChanged(() => void provider.refreshModels('invalidate').catch(() => provider.refreshModelPicker())),
  );

  const copilotChat = vscode.extensions.getExtension('github.copilot-chat');
  if (copilotChat) {
    void Promise.resolve(copilotChat.activate()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      provider.logMetadata(`[copilot-chat] activation failed: ${message.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    });
  }
  if (legacyDataRemoved) void showLegacyResetPrompt();
  else void showInitialConnectionPrompt(context);
  void provider.refreshModels().catch(() => undefined);
}

export function deactivate(): void {}
