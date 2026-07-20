export class InMemoryMemento {
  readonly values: Map<string, unknown>;
  failUpdates = false;

  constructor(values = new Map<string, unknown>()) {
    this.values = values;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.failUpdates) throw new Error('Memento update failed.');
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {}
}