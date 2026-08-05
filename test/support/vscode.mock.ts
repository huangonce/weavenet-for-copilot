export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelThinkingPart {
  constructor(
    readonly value: string,
    readonly id?: string,
    readonly metadata?: Record<string, unknown>,
  ) {}
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

export const LanguageModelChatMessage = {
  User: (content: string | readonly unknown[], name?: string) => ({
    role: LanguageModelChatMessageRole.User,
    content: typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
    name,
  }),
  Assistant: (content: string | readonly unknown[], name?: string) => ({
    role: LanguageModelChatMessageRole.Assistant,
    content: typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
    name,
  }),
};

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

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  private cancelled = false;
  readonly token: {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: (listener: (value: void) => void) => { dispose(): void };
  };

  constructor() {
    const cancelled = () => this.cancelled;
    this.token = {
      get isCancellationRequested() { return cancelled(); },
      onCancellationRequested: this.emitter.event,
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export const env = {
  language: 'en',
};

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
  createOutputChannel: (_name: string) => {
    const lines: string[] = [];
    return { lines, appendLine(value: string) { lines.push(value); }, show(_preserveFocus?: boolean) {}, dispose() {} };
  },
  createStatusBarItem: (_alignment: number, _priority: number) => new StatusBarItem(),
};

export class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  show(): void {}
  dispose(): void {}
}

export class Disposable {
  static from(..._disposables: Disposable[]): Disposable {
    return new Disposable();
  }

  dispose(): void {}
}

export const commands = {
  registerCommand: (_id: string, _handler: unknown) => new Disposable(),
  executeCommand: async (_id: string, ..._args: unknown[]): Promise<unknown> => undefined,
};

export const lm = {
  selectChatModels: async (_selector?: unknown): Promise<unknown[]> => [],
  registerLanguageModelChatProvider: (_vendor: string, _provider: unknown) => new Disposable(),
  get onDidChangeChatModels() { return onDidChangeChatModels; },
  fireDidChangeChatModels,
};

const chatModelListeners = new Set<() => void>();

function onDidChangeChatModels(listener: () => void) {
  chatModelListeners.add(listener);
  return { dispose: () => chatModelListeners.delete(listener) };
}

export function fireDidChangeChatModels(): number {
  for (const listener of chatModelListeners) listener();
  return chatModelListeners.size;
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const workspace = {
  getConfiguration: (_section?: string): unknown => ({}),
  get onDidChangeConfiguration() { return onDidChangeConfiguration; },
  fireDidChangeConfiguration,
  workspaceFolders: undefined as undefined | Array<{ uri: { toString(): string } }>,
};

const configurationListeners = new Set<(event: { affectsConfiguration(section: string): boolean }) => void>();

function onDidChangeConfiguration(listener: (event: { affectsConfiguration(section: string): boolean }) => void) {
  configurationListeners.add(listener);
  return { dispose: () => configurationListeners.delete(listener) };
}

export function fireDidChangeConfiguration(...sections: string[]): number {
  const event = {
    affectsConfiguration: (section: string) => sections.some((changed) =>
      changed === section || changed.startsWith(`${section}.`) || section.startsWith(`${changed}.`),
    ),
  };
  for (const listener of configurationListeners) listener(event);
  return configurationListeners.size;
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  Notification = 15,
}
