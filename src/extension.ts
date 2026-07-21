import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { VENDOR } from './constants';
import type { ConnectionStatus, ConnectionTestFailure } from './copilot/provider';
import { ConnectionTestError, WeaveNetChatProvider } from './copilot/provider';
import type { ConnectionProbeResult } from './copilot/connectionDiagnostics';
import type { ConnectionProfile } from './config/config';
import { getConfig, getProfileConfiguration, isValidProfileName, normalizeConnectionProfiles } from './config/config';
import { initMetadataCache, onMetadataChanged } from './metadata/metadataCache';
import { scheduleOpenRouterRefresh } from './metadata/openrouterFallback';
import { resetLegacyInstallation } from './migration/legacyReset';
import { migrateProfilePoolConfiguration } from './migration/profilePool';
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
  try {
    await migrateProfilePoolConfiguration();
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not upgrade Relay connections to the connection pool format: ${errorMessage(error)}`);
  }
  const provider = new WeaveNetChatProvider(context);
  try {
    await provider.migrateRelayKeys(getProfileConfiguration().profiles);
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not migrate Relay API keys to stable connection identities: ${errorMessage(error)}`);
  }
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
    vscode.commands.registerCommand('weavenet-copilot.refreshModels', () => provider.refreshModels('invalidate', true)),
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
    { label: '$(refresh) Refresh All Connections', command: 'refresh' },
    { label: '$(refresh) Refresh One Connection', command: 'refreshOne' },
    { label: '$(key) Set Relay API Key', command: 'setKey' },
    { label: '$(key) Clear Relay API Key', command: 'clearKey' },
    { label: '$(edit) Edit Connection', command: 'edit' },
    { label: '$(copy) Copy Connection', command: 'copy' },
    { label: '$(beaker) Test Connection', command: 'test' },
    { label: '$(trash) Delete Connection', command: 'delete' },
    { label: '$(clear-all) Clear All Relay Connections', command: 'clearAll' },
  ], { placeHolder: 'Manage WeaveNet Relay connections' });
  if (!action) return;
  switch (action.command) {
    case 'add': await addConnection(provider); break;
    case 'refresh': await provider.refreshModels('invalidate', true); break;
    case 'refreshOne': {
      const profile = await pickProfile('Select a connection to refresh');
      if (profile) await provider.refreshConnection(profile.id);
      break;
    }
    case 'setKey': await configureActiveRelay(provider); break;
    case 'clearKey': await clearActiveRelayKey(provider); break;
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
  const profile: ConnectionProfile = { id: randomUUID(), name: name.trim(), baseUrl };
  const apiKey = await provider.promptForRelayKeyValue(profile.name);
  if (!apiKey) return;
  await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return;
    }
    let configurationSaved = false;
    try {
      await saveProfiles([...profiles, profile]);
      configurationSaved = true;
      if (apiKey) await provider.storeRelayKey(profile, apiKey);
    } catch (error) {
      if (configurationSaved) await restoreProfiles(profiles);
      await provider.clearRelayKeyForProfile(profile).catch(() => undefined);
      void vscode.window.showErrorMessage(`WeaveNet could not create “${profile.name}”: ${errorMessage(error)}`);
      return;
    }
    await provider.refreshModels();
    void vscode.window.showInformationMessage(`WeaveNet connection “${profile.name}” created and enabled.`);
  });
}

export async function setDefaultConnection(provider: WeaveNetChatProvider): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'All WeaveNet connections are enabled simultaneously; a default connection is no longer required.',
    'Manage Connections',
  );
  if (action === 'Manage Connections') await manageConnections(provider);
}

export async function configureActiveRelay(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await selectProfileForKey('Select a connection whose API key will be set');
  if (!profile) {
    if (!getProfileConfiguration().profiles.length) await addConnection(provider);
    return;
  }
  const apiKey = await provider.promptForRelayKeyValue(profile.name);
  if (!apiKey) return;
  const stored = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    const current = profiles.find((entry) => entry.id === profile.id);
    if (!current) {
      void vscode.window.showErrorMessage('This connection was deleted while updating its API key. Please try again.');
      return false;
    }
    await provider.storeRelayKey(current, apiKey);
    return true;
  });
  if (!stored) return;
  await provider.refreshConnection(profile.id);
  void vscode.window.showInformationMessage(`WeaveNet API key for “${profile.name}” saved.`);
}

export async function clearActiveRelayKey(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await selectProfileForKey('Select a connection whose API key will be cleared');
  if (!profile) {
    if (!getProfileConfiguration().profiles.length) void vscode.window.showInformationMessage('WeaveNet has no Relay connection API key to clear.');
    return;
  }
  const cleared = await runConnectionMutation(async () => {
    const current = getProfileConfiguration().profiles.find((entry) => entry.id === profile.id);
    if (!current) return false;
    await provider.clearRelayKeyForProfile(current);
    void vscode.window.showInformationMessage(`WeaveNet API key for “${current.name}” cleared.`);
    return true;
  });
  if (cleared) await provider.refreshConnection(profile.id);
}

async function selectProfileForKey(placeHolder: string): Promise<ConnectionProfile | undefined> {
  const profiles = getProfileConfiguration().profiles;
  if (profiles.length === 1) return profiles[0];
  if (!profiles.length) return undefined;
  return pickProfile(placeHolder);
}

export async function editConnection(provider: WeaveNetChatProvider): Promise<void> {
  const oldProfile = await pickProfile('Select a connection to edit');
  if (!oldProfile) return;
  const profile = await promptConnectionDraft(oldProfile);
  if (!profile) return;
  await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    const current = profiles.find((entry) => entry.id === oldProfile.id);
    if (!current || !profilesEqual(current, oldProfile)) {
      void vscode.window.showErrorMessage('This connection was changed while editing. Please try again.');
      return;
    }
    if (profile.name !== oldProfile.name && profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return;
    }
    const updated = profiles.map((entry) => entry.id === oldProfile.id ? profile : entry);
    try {
      await saveProfiles(updated);
    } catch (error) {
      void vscode.window.showErrorMessage(`WeaveNet could not update “${oldProfile.name}”: ${errorMessage(error)}`);
      return;
    }
    await clearDiagnosticsBestEffort(provider, oldProfile);
    await provider.refreshModels();
  });
}

export async function copyConnection(provider: WeaveNetChatProvider): Promise<void> {
  const source = await pickProfile('Select a connection to copy');
  if (!source) return;
  const name = await vscode.window.showInputBox({ prompt: 'Name for the copied connection', value: `${source.name} copy`, ignoreFocusOut: true, validateInput: validateProfileName });
  if (!name) return;
  const copy = { ...source, id: randomUUID(), name: name.trim() };
  const copied = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.id === source.id)) {
      void vscode.window.showErrorMessage('This connection was changed while copying it. Please try again.');
      return false;
    }
    if (profiles.some((entry) => entry.name === copy.name)) {
      void vscode.window.showErrorMessage('A connection with this name already exists.');
      return false;
    }
    await saveProfiles([...profiles, copy]);
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
    { modal: true, detail: 'The connection and its separately stored API key will both be deleted.' },
    'Delete Connection and API Key',
  );
  if (!choice) return;
  const deleted = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.id === profile.id)) {
      void vscode.window.showErrorMessage('This connection was already deleted.');
      return false;
    }
    const remaining = profiles.filter((entry) => entry.id !== profile.id);
    let configurationSaved = false;
    try {
      await saveProfiles(remaining);
      configurationSaved = true;
      await provider.clearRelayKeyForProfile(profile);
      return true;
    } catch (error) {
      if (configurationSaved) await restoreProfiles(profiles);
      void vscode.window.showErrorMessage(`WeaveNet could not delete “${profile.name}”: ${errorMessage(error)}`);
      return false;
    }
  });
  if (!deleted) return;
  await clearDiagnosticsBestEffort(provider, profile);
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
    { modal: true, detail: 'This permanently removes every Relay connection setting and its separately stored API key.' },
    'Clear All Connections',
  );
  if (!choice) return;
  const cleared = await runConnectionMutation(async () => {
    const { profiles: currentProfiles } = getProfileConfiguration();
    if (!currentProfiles.length) {
      void vscode.window.showInformationMessage('WeaveNet has no Relay connections to clear.');
      return false;
    }
    let configurationSaved = false;
    try {
      await saveProfiles([]);
      configurationSaved = true;
      await provider.clearAllRelayKeys(currentProfiles);
      return true;
    } catch (error) {
      if (configurationSaved) await restoreProfiles(currentProfiles);
      void vscode.window.showErrorMessage(`WeaveNet could not clear all Relay connections and API keys: ${errorMessage(error)}`);
      return false;
    }
  });
  if (!cleared) return;
  await clearAllDiagnosticsBestEffort(provider);
  await provider.refreshModels();
  void vscode.window.showInformationMessage('All WeaveNet Relay connections and their API keys were cleared.');
}

export async function testConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile('Select a connection to test');
  if (!profile) return;
  try {
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Testing WeaveNet connection “${profile.name}” (may use a small amount of provider quota)`,
      cancellable: false,
    }, () => provider.testConnection(profile));
    const detail = [
      `Overall: ${result.overall}`,
      `Models discovered: ${result.modelCount}`,
      ...result.probes.map(formatProbeResult),
    ].filter(Boolean).join('\n');
    void vscode.window.showInformationMessage(`WeaveNet connection test ${result.overall}: ${result.host}, ${result.elapsedMs} ms.`, { modal: false, detail });
  } catch (error) {
    const failure = error instanceof ConnectionTestError
      ? error.failure
      : { category: 'unknown' as const, message: 'Connection failed.' };
    void vscode.window.showErrorMessage(`WeaveNet connection test failed: ${failure.message}`, { modal: false, detail: formatConnectionFailure(failure) });
  }
}

async function pickProfile(placeHolder: string): Promise<ConnectionProfile | undefined> {
  const { profiles } = getProfileConfiguration();
  const selection = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: `$(server) ${profile.name}`, description: profile.baseUrl, detail: 'Enabled', profile })), { placeHolder });
  return selection?.profile;
}

export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(configurationSection);
  await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

async function restoreProfiles(profiles: ConnectionProfile[]): Promise<void> {
  try {
    await saveProfiles(profiles);
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

async function promptConnectionDraft(oldProfile: ConnectionProfile): Promise<ConnectionProfile | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Connection name', value: oldProfile.name, ignoreFocusOut: true,
    validateInput: (value) => validateEditedProfileName(value, oldProfile.name),
  });
  if (!name) return undefined;
  const baseUrlValue = await vscode.window.showInputBox({
    prompt: 'Relay API base URL', value: oldProfile.baseUrl, ignoreFocusOut: true,
    validateInput: (value) => normalizeRelayBaseUrl(value) ? undefined : 'Enter an http(s) URL without credentials, query parameters, or fragments.',
  });
  if (!baseUrlValue) return undefined;
  const headers = await promptDraftJson<Record<string, string>>(
    'Extra request headers JSON (regular settings; do not enter secrets)',
    oldProfile.requestHeaders ?? {},
    (value) => {
      if (!isJsonRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) throw new Error('Invalid request headers.');
      return normalizeConnectionProfiles([{ id: oldProfile.id, name: name.trim(), baseUrl: baseUrlValue, requestHeaders: value }])[0]?.requestHeaders ?? {};
    },
  );
  if (headers === undefined) return undefined;
  const filters = await promptDraftJson<{ includeModels?: string[]; excludeModels?: string[] }>(
    'Model filters JSON: {"includeModels":[],"excludeModels":[]}',
    { includeModels: oldProfile.includeModels, excludeModels: oldProfile.excludeModels },
    (value) => {
      if (!isJsonRecord(value)
        || !isOptionalStringArray(value.includeModels)
        || !isOptionalStringArray(value.excludeModels)) throw new Error('Invalid model filters.');
      const normalized = normalizeConnectionProfiles([{ id: oldProfile.id, name: name.trim(), baseUrl: baseUrlValue, ...value }])[0];
      if (!normalized) throw new Error('Invalid model filters.');
      return { includeModels: normalized.includeModels, excludeModels: normalized.excludeModels };
    },
  );
  if (filters === undefined) return undefined;
  const models = await promptDraftJson<NonNullable<ConnectionProfile['models']>>(
    'Fixed model routes JSON array',
    oldProfile.models ?? [],
    (value) => {
      if (!Array.isArray(value)) throw new Error('Invalid fixed models.');
      const normalized = normalizeConnectionProfiles([{ id: oldProfile.id, name: name.trim(), baseUrl: baseUrlValue, models: value }])[0]?.models ?? [];
      if (normalized.length !== value.length) throw new Error('Invalid fixed models.');
      return normalized;
    },
  );
  if (models === undefined) return undefined;
  const normalized = normalizeConnectionProfiles([{
    id: oldProfile.id,
    name: name.trim(),
    baseUrl: baseUrlValue,
    requestHeaders: headers,
    includeModels: filters.includeModels,
    excludeModels: filters.excludeModels,
    models,
  }])[0];
  return normalized;
}

async function promptDraftJson<T>(prompt: string, initial: T, normalize: (value: T) => T): Promise<T | undefined> {
  let parsed: T | undefined;
  const value = await vscode.window.showInputBox({
    prompt,
    value: JSON.stringify(initial),
    ignoreFocusOut: true,
    validateInput: (input) => {
      try { parsed = normalize(JSON.parse(input) as T); return undefined; }
      catch { parsed = undefined; return 'Enter valid JSON matching the requested shape.'; }
    },
  });
  if (value === undefined) return undefined;
  try { return normalize(JSON.parse(value) as T); }
  catch { return parsed; }
}

function validateEditedProfileName(value: string, previousName: string): string | undefined {
  const name = value.trim();
  if (name === previousName) return undefined;
  return validateProfileName(value);
}

function profilesEqual(left: ConnectionProfile, right: ConnectionProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

async function clearDiagnosticsBestEffort(provider: WeaveNetChatProvider, profile: ConnectionProfile): Promise<void> {
  try { await provider.clearConnectionDiagnostics(profile); }
  catch (error) { provider.logMetadata(`Could not clear cached diagnostics for “${profile.name}”: ${errorMessage(error)}`); }
}

async function clearAllDiagnosticsBestEffort(provider: WeaveNetChatProvider): Promise<void> {
  try { await provider.clearAllConnectionDiagnostics(); }
  catch (error) { provider.logMetadata(`Could not clear cached connection diagnostics: ${errorMessage(error)}`); }
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
  if (status.phase === 'unconfigured') item.text = '$(plug) WeaveNet: Add Relay Connection';
  else if (status.phase === 'refreshing') item.text = `$(sync~spin) WeaveNet · ${status.connectionCount} connections · refreshing…`;
  else if (status.warningCount) item.text = `$(warning) WeaveNet · ${status.modelCount} models · ${status.warningCount} warning${status.warningCount === 1 ? '' : 's'}`;
  else item.text = `$(check) WeaveNet · ${status.connectionCount} connections · ${status.modelCount} models`;
  item.tooltip = status.connections.map((connection) => [
    `${connection.connectionName}${connection.host ? ` (${connection.host})` : ''}`,
    `${connection.modelCount} model(s) · ${connection.phase}`,
    connection.modelRefreshedAt ? `Models refreshed: ${new Date(connection.modelRefreshedAt).toLocaleString()}` : undefined,
    connection.lastDiagnostics ? `Last test: ${new Date(connection.lastDiagnostics.completedAt).toLocaleString()} (${connection.lastDiagnostics.overall})` : undefined,
    connection.message,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function formatProbeResult(probe: ConnectionProbeResult): string {
  const metadata = [
    probe.status ? `HTTP ${probe.status}` : undefined,
    probe.responseType,
    probe.requestId ? `request ${probe.requestId}` : undefined,
    `${probe.elapsedMs} ms`,
  ].filter(Boolean).join(', ');
  const reason = probe.failure?.message ?? probe.skippedReason;
  return `${probe.probe}: ${probe.verdict}${metadata ? ` (${metadata})` : ''}${reason ? ` — ${reason}` : ''}`;
}
