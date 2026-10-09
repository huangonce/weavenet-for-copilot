import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionTestFailure, WeaveNetChatProvider } from '../copilot/provider';
import { ConnectionTestError } from '../copilot/provider';
import type { ConnectionProbeResult } from '../copilot/connectionDiagnostics';
import type { ApiType, ConnectionProfile } from '../config/config';
import { getConfig, getProfileConfiguration, isValidProfileName, normalizeConnectionProfiles } from '../config/config';
import { configurationSection, errorMessage, restoreProfiles, runConnectionMutation, saveProfiles } from '../config/connectionMutations';
import { VENDOR } from '../constants';
import { t } from '../l10n';
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
    vscode.commands.registerCommand('weavenet-copilot.refreshModels', () => provider.refreshModels('invalidate', true)),
    vscode.commands.registerCommand('weavenet-copilot.refreshModelMetadata', () => refreshModelMetadata(provider)),
    vscode.commands.registerCommand('weavenet-copilot.pickVisionProxyModel', () => pickVisionProxyModel(provider)),
    vscode.commands.registerCommand('weavenet-copilot.showDebugLog', () => provider.showDebugLog()),
    vscode.commands.registerCommand('weavenet-copilot.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', configurationSection)),
  );
}

async function manageConnections(provider: WeaveNetChatProvider): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: t('$(add) Add Relay Connection'), command: 'add' },
    { label: t('$(refresh) Refresh All Connections'), command: 'refresh' },
    { label: t('$(refresh) Refresh One Connection'), command: 'refreshOne' },
    { label: t('$(key) Set Relay API Key'), command: 'setKey' },
    { label: t('$(key) Clear Relay API Key'), command: 'clearKey' },
    { label: t('$(edit) Edit Connection'), command: 'edit' },
    { label: t('$(copy) Copy Connection'), command: 'copy' },
    { label: t('$(beaker) Test Connection'), command: 'test' },
    { label: t('$(trash) Delete Connection'), command: 'delete' },
    { label: t('$(clear-all) Clear All Relay Connections'), command: 'clearAll' },
    { label: t('$(cloud-download) Refresh Model Metadata'), command: 'metadata' },
    { label: t('$(eye) Pick Vision Proxy Model'), command: 'vision' },
  ], { placeHolder: t('Manage WeaveNet Relay connections') });
  if (!action) return;
  switch (action.command) {
    case 'add': await addConnection(provider); break;
    case 'refresh': await provider.refreshModels('invalidate', true); break;
    case 'refreshOne': {
      const profile = await pickProfile(t('Select a connection to refresh'));
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
    case 'metadata': await refreshModelMetadata(provider); break;
    case 'vision': await pickVisionProxyModel(provider); break;
  }
}

export async function addConnection(provider: WeaveNetChatProvider): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: t('Connection name'),
    placeHolder: t('e.g. Work relay'),
    ignoreFocusOut: true,
    validateInput: validateProfileName,
  });
  if (!name) return;
  const baseUrl = await promptBaseUrl();
  if (!baseUrl) return;
  const apiType = await promptApiType();
  if (!apiType) return;
  const profile: ConnectionProfile = { id: randomUUID(), name: name.trim(), baseUrl, apiType };
  const apiKey = await provider.promptForRelayKeyValue(profile.name);
  if (!apiKey) return;
  await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage(t('A connection with this name already exists.'));
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
      void vscode.window.showErrorMessage(t('WeaveNet could not create “{0}”: {1}', profile.name, errorMessage(error)));
      return;
    }
    await provider.refreshModels();
    void vscode.window.showInformationMessage(t('WeaveNet connection “{0}” created and enabled.', profile.name));
  });
}

export async function setDefaultConnection(provider: WeaveNetChatProvider): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    t('All WeaveNet connections are enabled simultaneously; a default connection is no longer required.'),
    t('Manage Connections'),
  );
  if (action === t('Manage Connections')) await manageConnections(provider);
}

export async function configureActiveRelay(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await selectProfileForKey(t('Select a connection whose API key will be set'));
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
      void vscode.window.showErrorMessage(t('This connection was deleted while updating its API key. Please try again.'));
      return false;
    }
    try {
      await provider.storeRelayKey(current, apiKey);
    } catch (error) {
      void vscode.window.showErrorMessage(t('WeaveNet could not save the API key for “{0}”: {1}', current.name, errorMessage(error)));
      return false;
    }
    return true;
  });
  if (!stored) return;
  await provider.refreshConnection(profile.id);
  void vscode.window.showInformationMessage(t('WeaveNet API key for “{0}” saved.', profile.name));
}

export async function clearActiveRelayKey(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await selectProfileForKey(t('Select a connection whose API key will be cleared'));
  if (!profile) {
    if (!getProfileConfiguration().profiles.length) void vscode.window.showInformationMessage(t('WeaveNet has no Relay connection API key to clear.'));
    return;
  }
  const cleared = await runConnectionMutation(async () => {
    const current = getProfileConfiguration().profiles.find((entry) => entry.id === profile.id);
    if (!current) return false;
    try {
      await provider.clearRelayKeyForProfile(current);
    } catch (error) {
      void vscode.window.showErrorMessage(t('WeaveNet could not clear the API key for “{0}”: {1}', current.name, errorMessage(error)));
      return false;
    }
    void vscode.window.showInformationMessage(t('WeaveNet API key for “{0}” cleared.', current.name));
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
  const oldProfile = await pickProfile(t('Select a connection to edit'));
  if (!oldProfile) return;
  const profile = await promptConnectionDraft(oldProfile);
  if (!profile) return;
  await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    const current = profiles.find((entry) => entry.id === oldProfile.id);
    if (!current || !profilesEqual(current, oldProfile)) {
      void vscode.window.showErrorMessage(t('This connection was changed while editing. Please try again.'));
      return;
    }
    if (profile.name !== oldProfile.name && profiles.some((entry) => entry.name === profile.name)) {
      void vscode.window.showErrorMessage(t('A connection with this name already exists.'));
      return;
    }
    const updated = profiles.map((entry) => entry.id === oldProfile.id ? profile : entry);
    try {
      await saveProfiles(updated);
    } catch (error) {
      void vscode.window.showErrorMessage(t('WeaveNet could not update “{0}”: {1}', oldProfile.name, errorMessage(error)));
      return;
    }
    await clearDiagnosticsBestEffort(provider, oldProfile);
    await provider.refreshModels();
  });
}

export async function copyConnection(provider: WeaveNetChatProvider): Promise<void> {
  const source = await pickProfile(t('Select a connection to copy'));
  if (!source) return;
  const name = await vscode.window.showInputBox({
    prompt: t('Name for the copied connection'),
    value: t('{0} copy', source.name),
    ignoreFocusOut: true,
    validateInput: validateProfileName,
  });
  if (!name) return;
  const copy = { ...source, id: randomUUID(), name: name.trim() };
  const copied = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.id === source.id)) {
      void vscode.window.showErrorMessage(t('This connection was changed while copying it. Please try again.'));
      return false;
    }
    if (profiles.some((entry) => entry.name === copy.name)) {
      void vscode.window.showErrorMessage(t('A connection with this name already exists.'));
      return false;
    }
    await saveProfiles([...profiles, copy]);
    return true;
  });
  if (!copied) return;
  void vscode.window.showInformationMessage(t('WeaveNet connection “{0}” copied without its API key.', copy.name));
  await provider.refreshModels();
}

export async function deleteConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile(t('Select a connection to delete'));
  if (!profile) return;
  const choice = await vscode.window.showWarningMessage(
    t('Delete connection “{0}”?', profile.name),
    { modal: true, detail: t('The connection and its separately stored API key will both be deleted.') },
    t('Delete Connection and API Key'),
  );
  if (!choice) return;
  const deleted = await runConnectionMutation(async () => {
    const { profiles } = getProfileConfiguration();
    if (!profiles.some((entry) => entry.id === profile.id)) {
      void vscode.window.showErrorMessage(t('This connection was already deleted.'));
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
      void vscode.window.showErrorMessage(t('WeaveNet could not delete “{0}”: {1}', profile.name, errorMessage(error)));
      return false;
    }
  });
  if (!deleted) return;
  await clearDiagnosticsBestEffort(provider, profile);
  await provider.refreshModels();
  void vscode.window.showInformationMessage(t('WeaveNet connection “{0}” and its API key were deleted.', profile.name));
}

export async function clearAllConnections(provider: WeaveNetChatProvider): Promise<void> {
  const { profiles } = getProfileConfiguration();
  if (!profiles.length) {
    void vscode.window.showInformationMessage(t('WeaveNet has no Relay connections to clear.'));
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    t('Clear all {0} WeaveNet Relay connection(s)?', profiles.length),
    { modal: true, detail: t('This permanently removes every Relay connection setting and its separately stored API key.') },
    t('Clear All Connections'),
  );
  if (!choice) return;
  const cleared = await runConnectionMutation(async () => {
    const { profiles: currentProfiles } = getProfileConfiguration();
    if (!currentProfiles.length) {
      void vscode.window.showInformationMessage(t('WeaveNet has no Relay connections to clear.'));
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
      void vscode.window.showErrorMessage(t('WeaveNet could not clear all Relay connections and API keys: {0}', errorMessage(error)));
      return false;
    }
  });
  if (!cleared) return;
  await clearAllDiagnosticsBestEffort(provider);
  await provider.refreshModels();
  void vscode.window.showInformationMessage(t('All WeaveNet Relay connections and their API keys were cleared.'));
}

export async function testConnection(provider: WeaveNetChatProvider): Promise<void> {
  const profile = await pickProfile(t('Select a connection to test'));
  if (!profile) return;
  try {
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: t('Testing WeaveNet connection “{0}” (may use a small amount of provider quota)', profile.name),
      cancellable: false,
    }, () => provider.testConnection(profile));
    const detail = [
      t('Overall: {0}', result.overall),
      t('Models discovered: {0}', result.modelCount),
      ...result.probes.map(formatProbeResult),
    ].filter(Boolean).join('\n');
    void vscode.window.showInformationMessage(
      t('WeaveNet connection test {0}: {1}, {2} ms.', result.overall, result.host, result.elapsedMs),
      { modal: false, detail },
    );
  } catch (error) {
    const failure = error instanceof ConnectionTestError
      ? error.failure
      : { category: 'unknown' as const, message: t('Connection failed.') };
    void vscode.window.showErrorMessage(
      t('WeaveNet connection test failed: {0}', failure.message),
      { modal: false, detail: formatConnectionFailure(failure) },
    );
  }
}

async function refreshModelMetadata(provider: WeaveNetChatProvider): Promise<void> {
  const config = getConfig();
  if (!config.modelMetadataEnabled) {
    void vscode.window.showInformationMessage(t('Online model metadata is disabled. Enable it in WeaveNet settings to refresh.'));
    return;
  }
  const refreshHours = config.metadataRefreshHours;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: t('WeaveNet: Refreshing model metadata'),
    cancellable: false,
  }, async () => {
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
    void vscode.window.showInformationMessage(t('No vision-capable language models were found. Enable an extension that provides a native vision model (for example GitHub Copilot), or load a WeaveNet model with native image input, and try again.'));
    return;
  }
  const items = candidates
    .map((model) => ({
      label: model.name,
      description: `${model.vendor}/${model.id}`,
      detail: model.vendor === VENDOR ? t('WeaveNet model with native image input') : t('Family: {0}', model.family),
      modelKey: `${model.vendor}/${model.id}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: t('Select the installed native vision model WeaveNet should use to describe images'),
    ignoreFocusOut: true,
  });
  if (!selection) return;
  await vscode.workspace.getConfiguration(configurationSection).update('visionProxyModel', selection.modelKey, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(t('WeaveNet vision proxy model set to “{0}”. Enable the vision proxy setting to start using it.', selection.modelKey));
}

async function pickProfile(placeHolder: string): Promise<ConnectionProfile | undefined> {
  const { profiles } = getProfileConfiguration();
  const selection = await vscode.window.showQuickPick(profiles.map((profile) => ({
    label: `$(server) ${profile.name}`,
    description: profile.baseUrl,
    detail: t('Enabled'),
    profile,
  })), { placeHolder });
  return selection?.profile;
}

export function validateProfileName(value: string, profiles = getProfileConfiguration().profiles): string | undefined {
  const name = value.trim();
  if (!name) return t('Connection name is required.');
  if (!isValidProfileName(name)) return t('Connection name must be 100 characters or fewer and cannot contain control characters.');
  return profiles.some((profile) => profile.name === name) ? t('A connection with this name already exists.') : undefined;
}

async function promptApiType(current: ApiType = 'chat-completions'): Promise<ApiType | undefined> {
  const items = [
    { label: 'Chat Completions', apiType: 'chat-completions' as const, description: 'POST /chat/completions' },
    { label: 'Responses', apiType: 'responses' as const, description: 'POST /responses' },
    { label: 'Anthropic Messages', apiType: 'messages' as const, description: 'POST /messages' },
  ];
  const selection = await vscode.window.showQuickPick(
    items.sort((a, b) => Number(b.apiType === current) - Number(a.apiType === current)),
    { placeHolder: t('Select the API your Relay provides; models can override it'), ignoreFocusOut: true },
  );
  return selection?.apiType;
}

async function promptBaseUrl(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: t('Relay API base URL'),
    placeHolder: 'https://relay.example.com/v1',
    ignoreFocusOut: true,
    validateInput: (input) => normalizeRelayBaseUrl(input) ? undefined : t('Use HTTPS, or HTTP for localhost, without credentials, query parameters, or fragments.'),
  });
  return value ? normalizeRelayBaseUrl(value) : undefined;
}

async function promptConnectionDraft(oldProfile: ConnectionProfile): Promise<ConnectionProfile | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: t('Connection name'), value: oldProfile.name, ignoreFocusOut: true,
    validateInput: (value) => validateEditedProfileName(value, oldProfile.name),
  });
  if (!name) return undefined;
  const baseUrlValue = await vscode.window.showInputBox({
    prompt: t('Relay API base URL'), value: oldProfile.baseUrl, ignoreFocusOut: true,
    validateInput: (value) => normalizeRelayBaseUrl(value) ? undefined : t('Use HTTPS, or HTTP for localhost, without credentials, query parameters, or fragments.'),
  });
  if (!baseUrlValue) return undefined;
  // The extra request headers step was removed from the wizard: prompting for a
  // JSON object here was confusing (it looked like the API key step) and
  // awkward to fill in. Editing keeps the connection's existing requestHeaders
  // untouched; users who need custom headers can still edit settings.json or
  // delete and recreate the connection.
  const apiType = await promptApiType(oldProfile.apiType);
  if (!apiType) return undefined;
  const headers = oldProfile.requestHeaders;
  const filters = await promptDraftJson<{ includeModels?: string[]; excludeModels?: string[] }>(
    t('Model filters JSON: {"includeModels":[],"excludeModels":[]}'),
    { includeModels: oldProfile.includeModels, excludeModels: oldProfile.excludeModels },
    (value) => {
      if (!isJsonRecord(value)
        || !isOptionalStringArray(value.includeModels)
        || !isOptionalStringArray(value.excludeModels)) throw new Error(t('Invalid model filters.'));
      const normalized = normalizeConnectionProfiles([{ id: oldProfile.id, name: name.trim(), baseUrl: baseUrlValue, ...value }])[0];
      if (!normalized) throw new Error(t('Invalid model filters.'));
      return { includeModels: normalized.includeModels, excludeModels: normalized.excludeModels };
    },
  );
  if (filters === undefined) return undefined;
  const models = await promptDraftJson<NonNullable<ConnectionProfile['models']>>(
    t('Model overrides JSON array (id, optional apiType and capabilities)'),
    oldProfile.models ?? [],
    (value) => {
      if (!Array.isArray(value)) throw new Error(t('Invalid fixed models.'));
      const normalized = normalizeConnectionProfiles([{ id: oldProfile.id, name: name.trim(), baseUrl: baseUrlValue, models: value }])[0]?.models ?? [];
      if (normalized.length !== value.length) throw new Error(t('Invalid fixed models.'));
      return normalized;
    },
  );
  if (models === undefined) return undefined;
  const normalized = normalizeConnectionProfiles([{
    id: oldProfile.id,
    name: name.trim(),
    baseUrl: baseUrlValue,
    apiType,
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
      catch { parsed = undefined; return t('Enter valid JSON matching the requested shape.'); }
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
    t('Category: {0}', failure.category),
    failure.status ? t('HTTP status: {0}', failure.status) : undefined,
    failure.responseType ? t('Response type: {0}', failure.responseType) : undefined,
    failure.requestId ? t('Request ID: {0}', failure.requestId) : undefined,
  ].filter(Boolean).join('\n');
}

export function showInitialConnectionPrompt(context: vscode.ExtensionContext): Promise<void> {
  return showConnectionPrompt(context, 'weavenet-copilot.addConnectionPrompted', t('WeaveNet needs a Relay connection before models can be loaded.'));
}

export async function showLegacyResetPrompt(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    t('WeaveNet removed the previous connection format and legacy API keys. Add a Relay connection to continue.'),
    t('Add Relay Connection'),
  );
  if (action === t('Add Relay Connection')) await vscode.commands.executeCommand('weavenet-copilot.addConnection');
}

async function showConnectionPrompt(context: vscode.ExtensionContext, promptKey: string, message: string): Promise<void> {
  if (context.globalState.get<boolean>(promptKey) || getProfileConfiguration().profiles.length) return;
  await context.globalState.update(promptKey, true);
  const action = await vscode.window.showInformationMessage(message, t('Add Relay Connection'));
  if (action === t('Add Relay Connection')) await vscode.commands.executeCommand('weavenet-copilot.addConnection');
}

function formatProbeResult(probe: ConnectionProbeResult): string {
  const metadata = [
    probe.status ? t('HTTP {0}', probe.status) : undefined,
    probe.responseType,
    probe.requestId ? t('request {0}', probe.requestId) : undefined,
    t('{0} ms', probe.elapsedMs),
  ].filter(Boolean).join(', ');
  const reason = probe.failure?.message ?? probe.skippedReason;
  return `${probe.probe}: ${probe.verdict}${metadata ? ` (${metadata})` : ''}${reason ? ` — ${reason}` : ''}`;
}
