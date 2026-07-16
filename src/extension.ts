import * as vscode from 'vscode';
import { VENDOR } from './constants';
import type { ConnectionStatus, ConnectionTestFailure } from './copilot/provider';
import { ConnectionTestError, WeaveNetChatProvider } from './copilot/provider';
import type { ConnectionProfile } from './config/config';
import { getConfig, getProfileConfiguration, isValidProfileName, normalizeConnectionProfiles } from './config/config';
import { initMetadataCache, onMetadataChanged } from './metadata/metadataCache';
import { scheduleOpenRouterRefresh } from './metadata/openrouterFallback';
import { resetLegacyInstallation } from './migration/legacyReset';
import { normalizeRelayBaseUrl } from './relay/url';

const configurationSection = 'weavenet-copilot';
let connectionMutation = Promise.resolve();

export function queueConnectionMutation<T>(
  previous: Promise<void>,
  operation: () => Promise<T>,
): { result: Promise<T>; next: Promise<void> } {
  const result = previous.then(operation, operation);
  return { result, next: result.then(() => undefined, () => undefined) };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let legacyDataRemoved = false;
  try {
    legacyDataRemoved = (await resetLegacyInstallation(context)).cleaned;
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not clear settings from the previous connection format: ${errorMessage(error)}`);
  }
  const provider = new WeaveNetChatProvider(context);
  initMetadataCache(context, (message) => provider.logMetadata(message));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'weavenet-copilot.manageConnections';
  context.subscriptions.push(statusBar, provider.onDidChangeConnectionStatus((status) => renderStatus(statusBar, status)));
  renderStatus(statusBar, provider.getConnectionStatus());
  statusBar.show();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    onMetadataChanged(() => void provider.refreshModels('invalidate').catch(() => provider.refreshModelPicker())),
    vscode.commands.registerCommand('weavenet-copilot.setRelayKey', () => configureActiveRelay(provider)),
    vscode.commands.registerCommand('weavenet-copilot.clearRelayKey', () => clearActiveRelayKey(provider)),
    vscode.commands.registerCommand('weavenet-copilot.switchProfile', () => setDefaultConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.createProfile', () => addConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.addConnection', () => addConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.editConnection', () => editConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.copyConnection', () => copyConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.deleteConnection', () => deleteConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.clearAllConnections', () => clearAllConnections(provider)),
    vscode.commands.registerCommand('weavenet-copilot.testConnection', () => testConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.setDefaultConnection', () => setDefaultConnection(provider)),
    vscode.commands.registerCommand('weavenet-copilot.manageConnections', () => manageConnections(provider)),
    vscode.commands.registerCommand('weavenet-copilot.refreshModels', () => provider.refreshModels('invalidate')),
    vscode.commands.registerCommand('weavenet-copilot.refreshModelMetadata', async () => {
      const refreshHours = getConfig().metadataRefreshHours;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'WeaveNet: Refreshing model metadata', cancellable: false }, async () => {
        await (scheduleOpenRouterRefresh(refreshHours * 3_600_000, true) ?? Promise.resolve());
        await provider.refreshModels('invalidate');
      });
    }),
    vscode.commands.registerCommand('weavenet-copilot.showDebugLog', () => provider.showDebugLog()),
    vscode.commands.registerCommand('weavenet-copilot.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', configurationSection)),
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

async function manageConnections(provider: WeaveNetChatProvider): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: '$(add) Add Relay Connection', command: 'add' },
    { label: '$(server) Set Default Connection', command: 'default' },
    { label: '$(edit) Edit Connection', command: 'edit' },
    { label: '$(copy) Copy Connection', command: 'copy' },
    { label: '$(beaker) Test Connection', command: 'test' },
    { label: '$(trash) Delete Connection', command: 'delete' },
    { label: '$(clear-all) Clear All Relay Connections', command: 'clearAll' },
  ], { placeHolder: 'Manage WeaveNet Relay connections' });
  if (!action) return;
  switch (action.command) {
    case 'add': await addConnection(provider); break;
    case 'default': await setDefaultConnection(provider); break;
    case 'edit': await editConnection(provider); break;
    case 'copy': await copyConnection(provider); break;
    case 'test': await testConnection(provider); break;
    case 'delete': await deleteConnection(provider); break;
    case 'clearAll': await clearAllConnections(provider); break;
  }
}

export async function addConnection(provider: WeaveNetChatProvider): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'Connection name', placeHolder: 'e.g. Work relay', ignoreFocusOut: true, validateInput: validateProfileName });
  if (!name) return;
  const baseUrl = await promptBaseUrl();
  if (!baseUrl) return;
  const profile: ConnectionProfile = { name: name.trim(), baseUrl };
  const apiKey = await provider.promptForRelayKeyValue(profile.name);
  if (!apiKey) return;
  await runConnectionMutation(async () => {
    const { profiles, activeProfile } = getProfileConfiguration();
    if (profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return;
    }
    let configurationSaved = false;
    try {
      await saveProfiles([...profiles, profile], profile.name);
      configurationSaved = true;
      await provider.storeRelayKey(profile.name, apiKey);
    } catch (error) {
      if (configurationSaved) await restoreProfiles(profiles, activeProfile);
      await provider.clearRelayKeyForProfile(profile.name).catch(() => undefined);
      void vscode.window.showErrorMessage(`WeaveNet could not create “${profile.name}”: ${errorMessage(error)}`);
      return;
    }
    await provider.refreshModels();
    void vscode.window.showInformationMessage(`WeaveNet connection “${profile.name}” created and activated.`);
  });
}

export async function setDefaultConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile('Select the default WeaveNet connection');
  if (!profile) return;
  const updated = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('This connection was changed while selecting it. Please try again.');
      return false;
    }
    await saveProfiles(profiles, profile.name);
    return true;
  });
  if (!updated) return;
  await provider.refreshModels();
  void vscode.window.showInformationMessage(`WeaveNet default connection set to “${profile.name}”.`);
}

export async function configureActiveRelay(provider: WeaveNetChatProvider): Promise<void> {
  const { activeProfile } = getProfileConfiguration();
  if (!activeProfile) {
    await addConnection(provider);
    return;
  }
  const apiKey = await provider.promptForRelayKeyValue(activeProfile);
  if (!apiKey) return;
  const stored = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((profile) => profile.name === activeProfile)) {
      void vscode.window.showErrorMessage('This connection was deleted while updating its API key. Please try again.');
      return false;
    }
    await provider.storeRelayKey(activeProfile, apiKey);
    return true;
  });
  if (!stored) return;
  await provider.refreshModels('invalidate');
  void vscode.window.showInformationMessage(`WeaveNet API key for “${activeProfile}” saved.`);
}

export async function clearActiveRelayKey(provider: WeaveNetChatProvider): Promise<void> {
  const cleared = await runConnectionMutation(async () => {
    const { activeProfile, profiles } = getProfileConfiguration();
    if (!activeProfile || !profiles.some((profile) => profile.name === activeProfile)) {
      void vscode.window.showInformationMessage('WeaveNet has no active Relay connection API key to clear.');
      return false;
    }
    await provider.clearRelayKeyForProfile(activeProfile);
    void vscode.window.showInformationMessage(`WeaveNet API key for “${activeProfile}” cleared.`);
    return true;
  });
  if (cleared) await provider.refreshModels('invalidate');
}

export async function editConnection(provider: WeaveNetChatProvider): Promise<void> {
  const oldProfile = await pickProfile('Select a connection to edit');
  if (!oldProfile) return;
  const value = await vscode.window.showInputBox({
    prompt: 'Edit connection JSON (API keys are stored separately)', value: JSON.stringify(oldProfile), ignoreFocusOut: true,
    validateInput: (input) => parseSingleProfile(input, oldProfile.name) ? undefined : 'Enter one valid connection object with name and baseUrl.',
  });
  if (!value) return;
  const profile = parseSingleProfile(value, oldProfile.name);
  if (!profile) return;
  await runConnectionMutation(async () => {
    const { profiles, activeProfile } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.name === oldProfile.name)) {
      void vscode.window.showErrorMessage('This connection was changed while editing. Please try again.');
      return;
    }
    if (profile.name !== oldProfile.name && profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return;
    }
    const updated = profiles.map((entry) => entry.name === oldProfile.name ? profile : entry);
    const nextActiveProfile = activeProfile === oldProfile.name ? profile.name : activeProfile;
    let keyMoveAttempted = false;
    try {
      if (profile.name !== oldProfile.name) {
        keyMoveAttempted = true;
        await provider.moveRelayKey(oldProfile.name, profile.name);
      }
      await saveProfiles(updated, nextActiveProfile);
    } catch (error) {
      if (keyMoveAttempted) {
        await provider.moveRelayKey(profile.name, oldProfile.name).catch(() => undefined);
      }
      void vscode.window.showErrorMessage(`WeaveNet could not update “${oldProfile.name}”: ${errorMessage(error)}`);
      return;
    }
    await provider.refreshModels();
  });
}

export async function copyConnection(provider: WeaveNetChatProvider): Promise<void> {
  const source = await pickProfile('Select a connection to copy');
  if (!source) return;
  const name = await vscode.window.showInputBox({ prompt: 'Name for the copied connection', value: `${source.name} copy`, ignoreFocusOut: true, validateInput: validateProfileName });
  if (!name) return;
  const copy = { ...source, name: name.trim() };
  const copied = await runConnectionMutation(async () => {
    const { profiles, activeProfile } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.name === source.name)) {
      void vscode.window.showErrorMessage('This connection was changed while copying it. Please try again.');
      return false;
    }
    if (profiles.some((entry) => entry.name === copy.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return false;
    }
    if (await provider.hasRelayKey(copy.name)) {
      void vscode.window.showErrorMessage(`WeaveNet cannot copy to “${copy.name}” because that name already has a stored API key. Clear it or choose another name.`);
      return false;
    }
    await saveProfiles([...profiles, copy], activeProfile);
    return true;
  });
  if (!copied) return;
  void vscode.window.showInformationMessage(`WeaveNet connection “${copy.name}” copied without its API key.`);
  await provider.refreshModels();
}

export async function deleteConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile('Select a connection to delete');
  if (!profile) return;
  const choice = await vscode.window.showWarningMessage(
    `Delete connection “${profile.name}”?`,
    { modal: true, detail: 'This permanently removes the Relay connection and its API key.' },
    'Delete Connection',
  );
  if (!choice) return;
  const deleted = await runConnectionMutation(async () => {
    const { profiles, activeProfile } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('This connection was already deleted.');
      return false;
    }
    const remaining = profiles.filter((entry) => entry.name !== profile.name);
    let configurationSaved = false;
    try {
      await saveProfiles(remaining, activeProfile === profile.name ? remaining[0]?.name ?? '' : activeProfile);
      configurationSaved = true;
      await provider.clearRelayKeyForProfile(profile.name);
      return true;
    } catch (error) {
      if (configurationSaved) await restoreProfiles(profiles, activeProfile);
      void vscode.window.showErrorMessage(`WeaveNet could not delete “${profile.name}” and its API key: ${errorMessage(error)}`);
      return false;
    }
  });
  if (!deleted) return;
  await provider.refreshModels();
  void vscode.window.showInformationMessage(`WeaveNet connection “${profile.name}” and its API key were deleted.`);
}

export async function clearAllConnections(provider: WeaveNetChatProvider): Promise<void> {
  const { profiles } = getProfileConfiguration();
  if (!profiles.length) {
    void vscode.window.showInformationMessage('WeaveNet has no Relay connections to clear.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Clear all ${profiles.length} WeaveNet Relay connection(s)?`,
    { modal: true, detail: 'This permanently removes all Relay connection settings, API keys, and resets the active connection.' },
    'Clear All Connections',
  );
  if (!choice) return;
  const cleared = await runConnectionMutation(async () => {
    const { profiles: currentProfiles, activeProfile } = getProfileConfiguration();
    if (!currentProfiles.length) {
      void vscode.window.showInformationMessage('WeaveNet has no Relay connections to clear.');
      return false;
    }
    let configurationSaved = false;
    try {
      await saveProfiles([], '');
      configurationSaved = true;
      await provider.clearAllRelayKeys(currentProfiles.map((profile) => profile.name));
      return true;
    } catch (error) {
      if (configurationSaved) await restoreProfiles(currentProfiles, activeProfile);
      void vscode.window.showErrorMessage(`WeaveNet could not clear all Relay connections and API keys: ${errorMessage(error)}`);
      return false;
    }
  });
  if (!cleared) return;
  await provider.refreshModels();
  void vscode.window.showInformationMessage('All WeaveNet Relay connections and their API keys were cleared.');
}

export async function testConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile('Select a connection to test');
  if (!profile) return;
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing WeaveNet connection “${profile.name}”` }, () => provider.testConnection(profile.name, profile.baseUrl, profile.requestHeaders));
    const detail = [
      `Endpoint: ${result.endpoint}`,
      `Models: HTTP ${result.models.status}, ${result.models.responseType}, ${result.modelCount} model(s)`,
      result.models.requestId ? `Request ID: ${result.models.requestId}` : undefined,
      result.claudeMessages
        ? `Claude /messages: compatible (HTTP ${result.claudeMessages.status}, ${result.claudeMessages.responseType}${result.claudeMessages.requestId ? `, request ID ${result.claudeMessages.requestId}` : ''})`
        : result.claudeMessagesError
          ? `Claude /messages: unavailable — ${formatConnectionFailure(result.claudeMessagesError)}`
          : 'Claude /messages: not tested (no claude-* model discovered)',
    ].filter(Boolean).join('\n');
    void vscode.window.showInformationMessage(`WeaveNet connection succeeded: ${result.host}, ${result.modelCount} model(s), ${result.elapsedMs} ms.`, { modal: false, detail });
  } catch (error) {
    const failure = error instanceof ConnectionTestError
      ? error.failure
      : { category: 'unknown' as const, message: 'Connection failed.' };
    void vscode.window.showErrorMessage(`WeaveNet connection test failed: ${failure.message}`, { modal: false, detail: formatConnectionFailure(failure) });
  }
}

async function pickProfile(placeHolder: string): Promise<ConnectionProfile | undefined> {
  const { profiles, activeProfile } = getProfileConfiguration();
  const selection = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: `$(server) ${profile.name}`, description: profile.baseUrl, detail: profile.name === activeProfile ? 'Default connection' : undefined, profile })), { placeHolder });
  return selection?.profile;
}

export async function saveProfiles(profiles: ConnectionProfile[], activeProfile: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(configurationSection);
  const previousProfiles = configuration.inspect<ConnectionProfile[]>('profiles')?.globalValue;
  await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
  try {
    await configuration.update('activeProfile', activeProfile, vscode.ConfigurationTarget.Global);
  } catch (error) {
    await Promise.resolve(configuration.update('profiles', previousProfiles, vscode.ConfigurationTarget.Global)).catch(() => undefined);
    throw error;
  }
}

async function restoreProfiles(profiles: ConnectionProfile[], activeProfile: string): Promise<void> {
  try {
    await saveProfiles(profiles, activeProfile);
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not restore the connection configuration: ${errorMessage(error)}`);
  }
}

async function showInitialConnectionPrompt(context: vscode.ExtensionContext): Promise<void> {
  const promptKey = 'weavenet-copilot.addConnectionPrompted';
  if (context.globalState.get<boolean>(promptKey) || getProfileConfiguration().profiles.length) return;
  await context.globalState.update(promptKey, true);
  const action = await vscode.window.showInformationMessage('WeaveNet needs a Relay connection before models can be loaded.', 'Add Relay Connection');
  if (action === 'Add Relay Connection') await vscode.commands.executeCommand('weavenet-copilot.addConnection');
}

async function showLegacyResetPrompt(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'WeaveNet removed the previous connection format and legacy API keys. Add a Relay connection to continue.',
    'Add Relay Connection',
  );
  if (action === 'Add Relay Connection') await vscode.commands.executeCommand('weavenet-copilot.addConnection');
}

export function parseSingleProfile(value: string, previousName: string, profiles = getProfileConfiguration().profiles): ConnectionProfile | undefined {
  try {
    const [profile] = normalizeConnectionProfiles([JSON.parse(value)]);
    return profile && (profile.name === previousName || !profiles.some((entry) => entry.name === profile.name)) ? profile : undefined;
  } catch { return undefined; }
}

export function validateProfileName(value: string, profiles = getProfileConfiguration().profiles): string | undefined {
  const name = value.trim();
  if (!name) return 'Connection name is required.';
  if (!isValidProfileName(name)) return 'Connection name must be 100 characters or fewer and cannot contain control characters.';
  return profiles.some((profile) => profile.name === name) ? 'A connection with this name already exists.' : undefined;
}

async function promptBaseUrl(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({ prompt: 'Relay API base URL', placeHolder: 'https://relay.example.com/v1', ignoreFocusOut: true, validateInput: (input) => normalizeRelayBaseUrl(input) ? undefined : 'Enter an http(s) URL without credentials, query parameters, or fragments.' });
  return value ? normalizeRelayBaseUrl(value) : undefined;
}

function runConnectionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = queueConnectionMutation(connectionMutation, operation);
  connectionMutation = queued.next;
  return queued.result;
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error.'; }
export function formatConnectionFailure(failure: ConnectionTestFailure): string {
  return [
    `Category: ${failure.category}`,
    failure.status ? `HTTP status: ${failure.status}` : undefined,
    failure.responseType ? `Response type: ${failure.responseType}` : undefined,
    failure.requestId ? `Request ID: ${failure.requestId}` : undefined,
  ].filter(Boolean).join('\n');
}

export function renderStatus(item: vscode.StatusBarItem, status: ConnectionStatus): void {
  const label = status.connectionName ?? 'Add Relay Connection';
  if (status.phase === 'unconfigured') item.text = '$(plug) WeaveNet: Add Relay Connection';
  else if (status.phase === 'keyMissing') item.text = `$(key) WeaveNet: ${label} — API key required`;
  else if (status.phase === 'refreshing') item.text = `$(sync~spin) WeaveNet: ${label} — refreshing…`;
  else if (status.phase === 'ready') item.text = `$(check) WeaveNet: ${label} · ${status.modelCount} models`;
  else item.text = `$(error) WeaveNet: ${label} — ${status.message ?? 'connection failed'}`;
  item.tooltip = [label, status.host, `${status.modelCount} model(s)`, status.message].filter(Boolean).join('\n');
}
