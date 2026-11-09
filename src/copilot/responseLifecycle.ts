import * as vscode from 'vscode';
import type { ExtensionConfig } from '../config/config';
import type { RelayProtocol } from '../relay/types';
import { toLanguageModelError } from './connection';
import { createRequestDiagnostics } from './requestDiagnostics';
import type { DebugLogger, RequestDiagnostics } from './requestDiagnostics';
import { ResponsePartEmitter } from './responsePartEmitter';

interface ResponseLifecycleContext {
  readonly config: ExtensionConfig;
  readonly model: vscode.LanguageModelChatInformation;
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly token: vscode.CancellationToken;
  readonly debug: DebugLogger;
}

/** Settles streamed output and diagnostics after protocol-specific validation and publication. */
export async function runResponseLifecycle(
  context: ResponseLifecycleContext,
  protocol: RelayProtocol,
  messageCount: number,
  toolCount: number,
  operation: (output: ResponsePartEmitter, diagnostics: RequestDiagnostics) => Promise<void>,
): Promise<void> {
  const { config, model, progress, token, debug } = context;
  const diagnostics = createRequestDiagnostics(debug, config, protocol, model.id, messageCount, toolCount);
  const output = new ResponsePartEmitter(progress);
  let usageReported = false;
  const reportUsage = (): void => {
    if (usageReported || token.isCancellationRequested) return;
    const usage = diagnostics.getUsage();
    if (!usage) return;
    usageReported = true;
    // Agent Host's BYOK bridge consumes OpenAI-shaped JSON in a `usage` data part.
    progress.report(new vscode.LanguageModelDataPart(Buffer.from(JSON.stringify(usage), 'utf8'), 'usage'));
  };
  try {
    await operation(output, diagnostics);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    output.flush();
    reportUsage();
    diagnostics.complete();
  } catch (error) {
    if (token.isCancellationRequested) {
      output.discard();
      diagnostics.cancelled();
      throw new vscode.CancellationError();
    }
    try {
      output.flush();
      reportUsage();
    } catch {
      // Preserve the request failure when reporting the remaining text also
      // fails. A progress failure from the successful path is already primary.
    }
    diagnostics.failed(error);
    throw toLanguageModelError(error);
  }
}
