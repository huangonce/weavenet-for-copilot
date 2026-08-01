import type { RoutedModel } from '../relay/types';
import type { ConnectionRuntime } from './connectionRuntimeManager';

export interface BoundModel {
  readonly profileId: string;
  readonly revision: string;
  readonly model: RoutedModel;
}

/**
 * Namespaces a local picker id with the owning connection's profile id, so the
 * same upstream model can coexist across multiple relays in the picker.
 */
export function namespacedPickerId(profileId: string, localPickerId: string): string {
  return `weavenet::${profileId}::${encodeURIComponent(localPickerId)}`;
}

/**
 * Owns the provider-facing model bindings (picker id → bound model). The
 * registry is read-only for the rest of the extension: it is rebuilt from the
 * current connection runtimes whenever the catalog changes.
 */
export class ModelBindingRegistry {
  private readonly modelBindings = new Map<string, BoundModel>();

  rebuild(runtimes: Iterable<ConnectionRuntime>): void {
    this.modelBindings.clear();
    for (const runtime of runtimes) {
      for (const original of runtime.models) {
        const model = { ...original, pickerId: namespacedPickerId(runtime.profile.id, original.pickerId) };
        this.modelBindings.set(model.pickerId, { profileId: runtime.profile.id, revision: runtime.revision, model });
      }
    }
  }

  get(modelId: string): BoundModel | undefined {
    return this.modelBindings.get(modelId);
  }

  all(): BoundModel[] {
    return [...this.modelBindings.values()];
  }
}
