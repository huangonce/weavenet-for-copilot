export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelThinkingPart {
  constructor(readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(readonly callId: string, readonly name: string, readonly input: object) {}
}

export class LanguageModelToolResultPart {
  constructor(readonly callId: string, readonly content: readonly unknown[]) {}
}

export class LanguageModelDataPart {
  constructor(readonly data: Uint8Array, readonly mimeType: string) {}
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelError extends Error {
  readonly code: string;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.code = options?.code ?? 'Unknown';
  }

  static NoPermissions(message = 'No permissions'): LanguageModelError {
    return new LanguageModelError(message, { code: 'NoPermissions' });
  }

  static Blocked(message = 'Blocked'): LanguageModelError {
    return new LanguageModelError(message, { code: 'Blocked' });
  }

  static NotFound(message = 'Not found'): LanguageModelError {
    return new LanguageModelError(message, { code: 'NotFound' });
  }
}

export class CancellationError extends Error {}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const window = {
  showInformationMessage: async (_message: string): Promise<undefined> => undefined,
  showErrorMessage: async (_message: string): Promise<undefined> => undefined,
  showWarningMessage: async (_message: string): Promise<undefined> => undefined,
  showInputBox: async (_options: unknown): Promise<string | undefined> => undefined,
  showQuickPick: async <T>(_items: readonly T[], _options?: unknown): Promise<T | undefined> => undefined,
  withProgress: async <T>(_options: unknown, task: () => Promise<T>): Promise<T> => task(),
  createOutputChannel: (_name: string) => ({ appendLine(_value: string) {}, show(_preserveFocus?: boolean) {}, dispose() {} }),
};

export class StatusBarItem {
  text = '';
  tooltip: string | undefined;
}

export const workspace = {
  getConfiguration: (_section?: string): unknown => ({}),
  onDidChangeConfiguration: (_listener: (event: { affectsConfiguration(section: string): boolean }) => void) => ({ dispose() {} }),
  workspaceFolders: undefined as undefined | Array<{ uri: { toString(): string } }>,
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  Notification = 15,
}
