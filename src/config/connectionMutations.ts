import * as vscode from 'vscode';
import type { ConnectionProfile } from './config';

export const configurationSection = 'weavenet-copilot';

let connectionMutation = Promise.resolve();

/**
 * Queues a connection mutation behind the previous one. A failed mutation never
 * blocks the next one: the queue always drains in order.
 */
export function queueConnectionMutation<T>(
  previous: Promise<void>,
  operation: () => Promise<T>,
): { result: Promise<T>; next: Promise<void> } {
  const result = previous.then(operation, operation);
  return { result, next: result.then(() => undefined, () => undefined) };
}

/**
 * Serializes connection config/secret mutations so concurrent commands cannot
 * interleave (e.g. two edits racing over the same profile).
 */
export function runConnectionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = queueConnectionMutation(connectionMutation, operation);
  connectionMutation = queued.next;
  return queued.result;
}

/** Persists the connection pool as the only workspace-independent mutable setting. */
export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(configurationSection);
  await configuration.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

/** Best-effort rollback of a failed mutation; a rollback failure is surfaced but never thrown. */
export async function restoreProfiles(profiles: ConnectionProfile[]): Promise<void> {
  try {
    await saveProfiles(profiles);
  } catch (error) {
    void vscode.window.showErrorMessage(`WeaveNet could not restore the connection configuration: ${errorMessage(error)}`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
