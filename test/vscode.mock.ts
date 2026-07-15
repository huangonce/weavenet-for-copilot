export class LanguageModelTextPart {
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
  readonly event = () => ({ dispose() {} });
  fire(_value?: T): void {}
  dispose(): void {}
}

export const window = {
  showInformationMessage: async (_message: string): Promise<undefined> => undefined,
};

export const workspace = {
  getConfiguration: (_section?: string): unknown => ({}),
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
