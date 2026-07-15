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

export class EventEmitter<T> {
  readonly event = () => ({ dispose() {} });
  fire(_value?: T): void {}
  dispose(): void {}
}
