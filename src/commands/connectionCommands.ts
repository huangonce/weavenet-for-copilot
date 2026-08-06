import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionTestFailure, WeaveNetChatProvider } from '../copilot/provider';
import { ConnectionTestError } from '../copilot/provider';
import type { ConnectionProbeResult } from '../copilot/connectionDiagnostics';
import type { ConnectionProfile } from '../config/config';
import { getConfig, getProfileConfiguration, isValidProfileName, normalizeConnectionProfiles } from '../config/config';
import { configurationSection, errorMessage, restoreProfiles, runConnectionMutation, saveProfiles } from '../config/connectionMutations';
import { VENDOR } from '../constants';
import { scheduleOpenRouterRefresh } from '../metadata/openrouterFallback';
import { normalizeRelayBaseUrl } from '../relay/url';

/** Registers every WeaveNet command, wiring each one to the shared provider. */
export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  provider: WeaveNetChatProvider,
): vscode.Disposable {
  return vscode.Disposable.from(
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
    vscode.commands.registerCommand('weavenet-copilot.refreshModels', () => provider.refreshModels('invalidate', true, undefined, true)),
    vscode.commands.registerCommand('weavenet-copilot.refreshModelMetadata', () => refreshModelMetadata(provider)),
    vscode.commands.registerCommand('weavenet-copilot.pickVisionProxyModel', () => pickVisionProxyModel(provider)),
    vscode.commands.registerCommand('weavenet-copilot.showDebugLog', () => provider.showDebugLog()),
    vscode.commands.registerCommand('weavenet-copilot.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', configurationSection)),
  );
}

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
    try {
      await provider.storeRelayKey(current, apiKey);
    } catch (error) {
      void vscode.window.showErrorMessage(`WeaveNet could not save the API key for “${current.name}”: ${errorMessage(error)}`);
      return false;
    }
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
    try {
      await provider.clearRelayKeyForProfile(current);
    } catch (error) {
      void vscode.window.showErrorMessage(`WeaveNet could not clear the API key for “${current.name}”: ${errorMessage(error)}`);
      return false;
    }
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

async function refreshModelMetadata(provider: WeaveNetChatProvider): Promise<void> {
  const refreshHours = getConfig().metadataRefreshHours;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'WeaveNet: Refreshing model metadata', cancellable: false }, async () => {
    await (scheduleOpenRouterRefresh(refreshHours * 3_600_000, true) ?? Promise.resolve());
    await provider.refreshModels('invalidate');
  });
}

export async function pickVisionProxyModel(provider: WeaveNetChatProvider): Promise<void> {
  const models = await vscode.lm.selectChatModels();
  // WeaveNet's own models are usable as the vision proxy only when they have native image input;
  // that guard (and the target-model identity check in the runtime lookup) prevents recursion.
  const candidates = models.filter((model) => provider.isSafeVisionProxyCandidate(model));
  if (!candidates.length) {
    void vscode.window.showInformationMessage(
      'No vision-capable language models were found. Enable an extension that provides a native vision model (for example GitHub Copilot), or load a WeaveNet model with native image input, and try again.',
    );
    return;
  }
  const items = candidates
    .map((model) => ({
      label: model.name,
      description: `${model.vendor}/${model.id}`,
      detail: model.vendor === VENDOR ? 'WeaveNet model with native image input' : `Family: ${model.family}`,
      modelKey: `${model.vendor}/${model.id}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the installed native vision model WeaveNet should use to describe images',
    ignoreFocusOut: true,
  });
  if (!selection) return;
  await vscode.workspace.getConfiguration(configurationSection).update('visionProxyModel', selection.modelKey, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`WeaveNet vision proxy model set to “${selection.modelKey}”. Enable the vision proxy setting to start using it.`);
}

async function pickProfile(placeHolder: string): Promise<ConnectionProfile | undefined> {
  const { profiles } = getProfileConfiguration();
  const selection = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: `$(server) ${profile.name}`, description: profile.baseUrl, detail: 'Enabled', profile })), { placeHolder });
  return selection?.profile;
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
  // The extra request headers step was removed from the wizard: prompting for a
  // JSON object here was confusing (it looked like the API key step) and
  // awkward to fill in. Editing keeps the connection's existing requestHeaders
  // untouched; users who need custom headers can still edit settings.json or
  // delete and recreate the connection.
  const headers = oldProfile.requestHeaders;
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

export function formatConnectionFailure(failure: ConnectionTestFailure): string {
  return [
    `Category: ${failure.category}`,
    failure.status ? `HTTP status: ${failure.status}` : undefined,
    failure.responseType ? `Response type: ${failure.responseType}` : undefined,
    failure.requestId ? `Request ID: ${failure.requestId}` : undefined,
  ].filter(Boolean).join('\n');
}

export function showInitialConnectionPrompt(context: vscode.ExtensionContext): Promise<void> {
  return showConnectionPrompt(context, 'weavenet-copilot.addConnectionPrompted', 'WeaveNet needs a Relay connection before models can be loaded.');
}

export async function showLegacyResetPrompt(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'WeaveNet removed the previous connection format and legacy API keys. Add a Relay connection to continue.',
    'Add Relay Connection',
  );
  if (action === 'Add Relay Connection') await vscode.commands.executeCommand('weavenet-copilot.addConnection');
}

async function showConnectionPrompt(context: vscode.ExtensionContext, promptKey: string, message: string): Promise<void> {
  if (context.globalState.get<boolean>(promptKey) || getProfileConfiguration().profiles.length) return;
  await context.globalState.update(promptKey, true);
  const action = await vscode.window.showInformationMessage(message, 'Add Relay Connection');
  if (action === 'Add Relay Connection') await vscode.commands.executeCommand('weavenet-copilot.addConnection');
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
