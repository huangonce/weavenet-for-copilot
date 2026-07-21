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

/**
 * Returns a strict-compatible schema only when normalization cannot make an
 * optional property required. Unsupported or ambiguous schemas stay legacy.
 */
export function toStrictJsonSchema(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const normalized = normalizeStrictNode(value);
  return normalized && !Array.isArray(normalized) && typeof normalized === 'object'
    ? normalized as Record<string, unknown>
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

function normalizeStrictNode(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      const normalized = normalizeStrictNode(entry);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };
  const type = record.type;
  const isObject = type === 'object'
    || Array.isArray(type) && type.includes('object')
    || record.properties !== undefined;
  if (isObject) {
    if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) return undefined;
    const propertyNames = Object.keys(record.properties as Record<string, unknown>);
    const required = record.required;
    if (required === undefined && propertyNames.length === 0) result.required = [];
    else if (!Array.isArray(required)
      || required.some((entry) => typeof entry !== 'string')
      || required.length !== propertyNames.length
      || propertyNames.some((name) => !required.includes(name))) return undefined;
    if (record.additionalProperties === undefined) result.additionalProperties = false;
    else if (record.additionalProperties !== false) return undefined;
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
      const normalized = normalizeStrictNode(property);
      if (normalized === undefined) return undefined;
      properties[name] = normalized;
    }
    result.properties = properties;
  }
  for (const [key, nested] of Object.entries(result)) {
    if (key === 'properties') continue;
    if (key === '$defs' || key === 'definitions') {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
      const definitions: Record<string, unknown> = {};
      for (const [name, definition] of Object.entries(nested as Record<string, unknown>)) {
        const normalized = normalizeStrictNode(definition);
        if (normalized === undefined) return undefined;
        definitions[name] = normalized;
      }
      result[key] = definitions;
      continue;
    }
    if (!shouldNormalizeSchemaChild(key)) continue;
    const normalized = normalizeStrictNode(nested);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return result;
}

function shouldNormalizeSchemaChild(key: string): boolean {
  return key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf';
}
