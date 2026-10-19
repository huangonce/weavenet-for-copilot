const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'markdownDescription', 'markdownEnumDescriptions',
  'enumItemLabels', 'enumDescriptions', 'defaultSnippets', 'deprecationMessage',
  'errorMessage', 'patternErrorMessage', 'doNotSuggest', 'suggestSortText',
]);

const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_CHILD_KEYS = new Set([
  'items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema',
]);

// OpenAI's strict subset excludes composition/conditionals other than nested
// anyOf. Other schema-bearing shapes below cannot be safely normalized by
// this converter; retain their original constraints in non-strict mode.
const UNSAFE_STRICT_SCHEMA_KEYS = new Set([
  'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'patternProperties', 'propertyNames', 'unevaluatedProperties',
  'prefixItems', 'additionalItems', 'contains', 'minContains', 'maxContains', 'unevaluatedItems', 'contentSchema',
]);

export function sanitizeJsonSchema(value: unknown): Record<string, unknown> | undefined {
  const cleaned = sanitize(value);
  return cleaned && !Array.isArray(cleaned) && typeof cleaned === 'object'
    ? cleaned as Record<string, unknown>
    : undefined;
}

/**
 * Returns a strict-compatible schema only when normalization cannot make an
 * optional property required. Unsupported or ambiguous schemas remain non-strict.
 */
export function toStrictJsonSchema(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (value.type !== 'object' || Object.hasOwn(value, 'anyOf')) return undefined;
  const normalized = normalizeStrictNode(value);
  return normalized && !Array.isArray(normalized) && typeof normalized === 'object'
    ? normalized as Record<string, unknown>
    : undefined;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = dictionary();
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key) || nested === undefined) continue;
    const cleaned = SCHEMA_MAP_KEYS.has(key) || key === 'dependencies'
      ? sanitizeSchemaMap(nested, key === 'dependencies')
      : SCHEMA_CHILD_KEYS.has(key) ? sanitize(nested) : cloneData(nested);
    defineData(result, key, cleaned);
  }
  return result;
}

function sanitizeSchemaMap(value: unknown, dependencies: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return cloneData(value);
  const result = dictionary();
  for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
    // Dictionary keys are user-defined property/definition names. Legacy
    // dependencies also permit arrays of property names rather than schemas.
    defineData(result, name, dependencies && Array.isArray(schema) ? cloneData(schema) : sanitize(schema));
  }
  return result;
}

/** enum/const/default/examples and unknown extensions contain data, not schemas. */
function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneData);
  if (!value || typeof value !== 'object') return value;
  const result = dictionary();
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) defineData(result, key, cloneData(nested));
  return result;
}

function normalizeStrictNode(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => UNSAFE_STRICT_SCHEMA_KEYS.has(key))) return undefined;
  const result = dictionary();
  for (const [key, nested] of Object.entries(record)) defineData(result, key, nested);
  const type = record.type;
  const isObject = type === 'object'
    || Array.isArray(type) && type.includes('object')
    || record.properties !== undefined;
  if (isObject) {
    // Closing an object here cannot account for fields introduced by another
    // schema at the same instance location. Do not resolve or flatten refs.
    if (Object.hasOwn(record, '$ref') || Object.hasOwn(record, 'anyOf')) return undefined;
    if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) return undefined;
    const propertyNames = Object.keys(record.properties as Record<string, unknown>);
    const required = record.required;
    if (required === undefined && propertyNames.length === 0) defineData(result, 'required', []);
    else if (!Array.isArray(required)
      || required.some((entry) => typeof entry !== 'string')
      || required.length !== propertyNames.length
      || propertyNames.some((name) => !required.includes(name))) return undefined;
    if (record.additionalProperties === undefined) defineData(result, 'additionalProperties', false);
    else if (record.additionalProperties !== false) return undefined;
    const properties = dictionary();
    for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
      const normalized = normalizeStrictNode(property);
      if (normalized === undefined) return undefined;
      defineData(properties, name, normalized);
    }
    defineData(result, 'properties', properties);
  }
  for (const [key, nested] of Object.entries(result)) {
    if (key === 'properties') continue;
    if (key === '$defs' || key === 'definitions') {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
      const definitions = dictionary();
      for (const [name, definition] of Object.entries(nested as Record<string, unknown>)) {
        const normalized = normalizeStrictNode(definition);
        if (normalized === undefined) return undefined;
        defineData(definitions, name, normalized);
      }
      defineData(result, key, definitions);
      continue;
    }
    if (key === 'anyOf') {
      if (!Array.isArray(nested) || !nested.length) return undefined;
      const choices: unknown[] = [];
      for (const schema of nested) {
        const normalized = normalizeStrictNode(schema);
        if (normalized === undefined) return undefined;
        choices.push(normalized);
      }
      defineData(result, key, choices);
      continue;
    }
    if (key !== 'items') continue;
    const normalized = normalizeStrictNode(nested);
    if (normalized === undefined) return undefined;
    defineData(result, key, normalized);
  }
  return result;
}

function dictionary(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function defineData(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
