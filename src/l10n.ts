import * as vscode from 'vscode';

/**
 * Localizes user-facing text. VS Code resolves the English source string
 * through `l10n/bundle.l10n.<locale>.json` and falls back to the source text,
 * so the English message (with `{0}`-style placeholders) is the stable key in
 * both the code and the bundle.
 */
export function t(message: string, ...args: Array<string | number>): string {
  return vscode.l10n.t(message, ...args);
}
