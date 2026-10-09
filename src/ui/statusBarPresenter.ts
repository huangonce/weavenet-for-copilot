import * as vscode from 'vscode';
import type { ConnectionStatus } from '../copilot/provider';
import type { WeaveNetChatProvider } from '../copilot/provider';
import { t } from '../l10n';

/** Creates the status bar item, subscribes to provider status changes, and shows it. */
export function createStatusBarItem(
  context: vscode.ExtensionContext,
  provider: WeaveNetChatProvider,
): vscode.StatusBarItem {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'weavenet-copilot.manageConnections';
  context.subscriptions.push(statusBar, provider.onDidChangeConnectionStatus((status) => renderStatus(statusBar, status)));
  renderStatus(statusBar, provider.getConnectionStatus());
  statusBar.show();
  return statusBar;
}

export function renderStatus(item: vscode.StatusBarItem, status: ConnectionStatus): void {
  if (status.phase === 'unconfigured') item.text = t('$(plug) WeaveNet: Add Relay Connection');
  else if (status.phase === 'refreshing') item.text = t('$(sync~spin) WeaveNet · {0} connections · refreshing…', status.connectionCount);
  else if (status.warningCount) {
    item.text = status.warningCount === 1
      ? t('$(warning) WeaveNet · {0} models · {1} warning', status.modelCount, status.warningCount)
      : t('$(warning) WeaveNet · {0} models · {1} warnings', status.modelCount, status.warningCount);
  } else item.text = t('$(check) WeaveNet · {0} connections · {1} models', status.connectionCount, status.modelCount);
  item.tooltip = status.connections.map((connection) => [
    `${connection.connectionName}${connection.host ? ` (${connection.host})` : ''}`,
    t('{0} model(s) · {1}', connection.modelCount, connection.phase),
    connection.modelRefreshedAt ? t('Models refreshed: {0}', new Date(connection.modelRefreshedAt).toLocaleString()) : undefined,
    connection.lastDiagnostics ? t('Last test: {0} ({1})', new Date(connection.lastDiagnostics.completedAt).toLocaleString(), connection.lastDiagnostics.overall) : undefined,
    connection.message,
  ].filter(Boolean).join('\n')).join('\n\n');
}
