/**
 * Orders keys in already-normalized JSON data without changing array order or
 * JSON.stringify's treatment of undefined. Keep the historical localeCompare
 * ordering: persisted catalog identities, including v2 migration, depend on it.
 * This is an equality/identity helper, not validation for untrusted input.
 */
export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableJsonValue(entry)]));
}
