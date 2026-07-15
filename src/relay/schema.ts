const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'markdownDescription', 'markdownEnumDescriptions',
  'enumItemLabels', 'enumDescriptions', 'defaultSnippets', 'deprecationMessage',
  'errorMessage', 'patternErrorMessage', 'doNotSuggest', 'suggestSortText',
]);

export function sanitizeJsonSchema(value: unknown): Record<string, unknown> | undefined {
  const cleaned = sanitize(value);
  return cleaned && !Array.isArray(cleaned) && typeof cleaned === 'object'
    ? cleaned as Record<string, unknown>
    : undefined;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!UNSUPPORTED_SCHEMA_KEYS.has(key) && nested !== undefined) result[key] = sanitize(nested);
  }
  return result;
}
