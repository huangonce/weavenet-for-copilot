import * as vscode from 'vscode';
import type { ConnectionStatus } from '../copilot/provider';
import type { WeaveNetChatProvider } from '../copilot/provider';

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
