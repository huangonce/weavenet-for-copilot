const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', 'markdownDescription', 'markdownEnumDescriptions',
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
  'uniqueItems', '$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef',
]);

const STRICT_STRING_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
interface StrictBudget { properties: number; enumValues: number; stringLength: number }

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
  const normalized = normalizeStrictNode(value, { properties: 0, enumValues: 0, stringLength: 0 }, 0);
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

function normalizeStrictNode(value: unknown, budget: StrictBudget, objectDepth: number): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => UNSAFE_STRICT_SCHEMA_KEYS.has(key))) return undefined;
  if (record.format !== undefined && (typeof record.format !== 'string' || !STRICT_STRING_FORMATS.has(record.format))) return undefined;
  // Only fragment JSON pointers have unambiguous local semantics here. Keep
  // other references (and resource IDs) intact in the non-strict fallback.
  if (record.$ref !== undefined && (typeof record.$ref !== 'string'
    || record.$ref !== '#' && !record.$ref.startsWith('#/'))) return undefined;
  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum)) return undefined;
    const strings = record.enum.reduce<number>((length, item) => length + (typeof item === 'string' ? item.length : 0), 0);
    budget.enumValues += record.enum.length;
    budget.stringLength += strings;
    if (budget.enumValues > 1_000 || record.enum.length > 250 && strings > 15_000) return undefined;
  }
  if (typeof record.const === 'string') budget.stringLength += record.const.length;
  if (budget.stringLength > 120_000) return undefined;
  const result = dictionary();
  for (const [key, nested] of Object.entries(record)) defineData(result, key, nested);
  const type = record.type;
  const isObject = type === 'object'
    || Array.isArray(type) && type.includes('object')
    || record.properties !== undefined;
  if (isObject) {
    objectDepth += 1;
    if (objectDepth > 10) return undefined;
    // Closing an object here cannot account for fields introduced by another
    // schema at the same instance location. Do not resolve or flatten refs.
    if (Object.hasOwn(record, '$ref') || Object.hasOwn(record, 'anyOf')) return undefined;
    if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) return undefined;
    const propertyNames = Object.keys(record.properties as Record<string, unknown>);
    budget.properties += propertyNames.length;
    budget.stringLength += propertyNames.reduce((length, name) => length + name.length, 0);
    if (budget.properties > 5_000 || budget.stringLength > 120_000) return undefined;
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
      const normalized = normalizeStrictNode(property, budget, objectDepth);
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
        budget.stringLength += name.length;
        if (budget.stringLength > 120_000) return undefined;
        const normalized = normalizeStrictNode(definition, budget, objectDepth);
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
        const normalized = normalizeStrictNode(schema, budget, objectDepth);
        if (normalized === undefined) return undefined;
        choices.push(normalized);
      }
      defineData(result, key, choices);
      continue;
    }
    if (key !== 'items') continue;
    const normalized = normalizeStrictNode(nested, budget, objectDepth);
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
