import { describe, expect, it } from 'vitest';
import { sanitizeJsonSchema, toStrictJsonSchema } from '../../src/relay/schema';

describe('sanitizeJsonSchema', () => {
  it('removes editor-only schema fields recursively', () => {
    expect(sanitizeJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        query: {
          type: 'string',
          markdownDescription: 'editor only',
          defaultSnippets: [{ body: 'secret' }],
        },
      },
      required: ['query'],
    })).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('does not mutate the input', () => {
    const input = { type: 'object', properties: { value: { type: 'number', errorMessage: 'bad' } } };
    sanitizeJsonSchema(input);
    expect(input.properties.value.errorMessage).toBe('bad');
  });

  it('preserves root and embedded resource IDs used to resolve relative references', () => {
    const schema = { $id: 'https://schema.example.test/root', type: 'object',
      properties: { address: { $ref: 'address' } }, required: ['address'],
      $defs: { address: { $id: 'address', type: 'string', markdownDescription: 'editor-only' } } };
    expect(sanitizeJsonSchema(schema)).toEqual({ ...schema,
      $defs: { address: { $id: 'address', type: 'string' } } });
    expect(schema.$defs.address.markdownDescription).toBe('editor-only');
  });

  it.each(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])('preserves user-defined names inside %s', (key) => {
    const namedSchemas = JSON.parse('{"errorMessage":{"type":"string","errorMessage":"editor-only"},"$id":{"type":"number"},"markdownDescription":{"type":"boolean"},"__proto__":{"type":"string","markdownDescription":"editor-only"}}');
    const input = { [key]: namedSchemas };
    const result = sanitizeJsonSchema(input)?.[key] as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['errorMessage', '$id', 'markdownDescription', '__proto__']);
    expect(result.errorMessage).toEqual({ type: 'string' });
    expect(result.__proto__).toEqual({ type: 'string' });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(namedSchemas.errorMessage.errorMessage).toBe('editor-only');
  });

  it('clones literal data without treating its field names as schema annotations', () => {
    const literal = JSON.parse('{"errorMessage":"business data","$id":"record-1","markdownDescription":{"properties":{"errorMessage":"nested data"}},"__proto__":{"safe":true}}');
    const input = { enum: [literal], const: literal, default: literal, examples: [literal], 'x-custom': literal };
    const result = sanitizeJsonSchema(input)!;
    expect(result).toEqual(input);
    expect(result.const).not.toBe(literal);
    expect((result.enum as unknown[])[0]).not.toBe(literal);
    const cloned = result.const as Record<string, unknown>;
    expect(Object.getPrototypeOf(cloned)).toBeNull();
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(cloned.__proto__).toEqual({ safe: true });
    (cloned.markdownDescription as Record<string, unknown>).properties = 'changed clone';
    expect(literal.markdownDescription.properties).toEqual({ errorMessage: 'nested data' });
  });

  it('cleans schema-bearing combination, conditional, array and object keywords', () => {
    const nested = { type: 'string', markdownDescription: 'editor-only', const: { errorMessage: 'data' } };
    const expected = { type: 'string', const: { errorMessage: 'data' } };
    for (const key of ['items', 'additionalItems', 'contains', 'unevaluatedItems', 'additionalProperties',
      'unevaluatedProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']) {
      expect(sanitizeJsonSchema({ [key]: nested }), key).toEqual({ [key]: expected });
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']) {
      expect(sanitizeJsonSchema({ [key]: [nested, true, false] }), key).toEqual({ [key]: [expected, true, false] });
    }
    expect(sanitizeJsonSchema({ dependencies: { errorMessage: ['markdownDescription', '$id'], schema: nested },
      dependentRequired: { errorMessage: ['markdownDescription', '$id'] } })).toEqual({
      dependencies: { errorMessage: ['markdownDescription', '$id'], schema: expected },
      dependentRequired: { errorMessage: ['markdownDescription', '$id'] },
    });
  });

  it('keeps strict required-name checks intact after preserving annotation-like parameter names', () => {
    const parameters = sanitizeJsonSchema({ type: 'object',
      properties: { errorMessage: { type: 'string', errorMessage: 'editor-only' }, $id: { type: 'string' } },
      required: ['errorMessage', '$id'],
    })!;
    expect(toStrictJsonSchema(parameters)).toEqual({ ...parameters, additionalProperties: false });
    expect(toStrictJsonSchema({ ...parameters, required: ['errorMessage'] })).toBeUndefined();
    expect(toStrictJsonSchema({ ...parameters, additionalProperties: true })).toBeUndefined();
  });

  it('preserves special schema keys as own data without changing prototypes', () => {
    const properties = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(properties, '__proto__', {
      value: { type: 'string' }, enumerable: true, writable: true, configurable: true,
    });
    properties['constructor'] = { type: 'number' };
    properties.prototype = { type: 'boolean' };
    const schema = { type: 'object', properties, required: ['__proto__', 'constructor', 'prototype'], additionalProperties: false };

    const sanitized = sanitizeJsonSchema(schema);
    const sanitizedProperties = sanitized?.properties as Record<string, unknown>;
    expect(Object.getPrototypeOf(sanitizedProperties)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(sanitizedProperties, '__proto__')).toBe(true);
    expect(sanitizedProperties.__proto__).toEqual({ type: 'string' });

    const strict = sanitized && toStrictJsonSchema(sanitized);
    const strictProperties = strict?.properties as Record<string, unknown>;
    expect(Object.getPrototypeOf(strictProperties)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(strictProperties, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(strict))).toMatchObject({
      properties: {
        __proto__: { type: 'string' },
        constructor: { type: 'number' },
        prototype: { type: 'boolean' },
      },
    });
  });
});

describe('strict schema subset', () => {
  it.each(['allOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies',
    'patternProperties', 'propertyNames', 'unevaluatedProperties', 'prefixItems', 'additionalItems', 'contains',
    'minContains', 'maxContains', 'unevaluatedItems', 'contentSchema'])('does not mark an unsupported %s structure strict', (key) => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'],
      [key]: key.endsWith('Of') || key === 'prefixItems' ? [{ type: 'string' }] : {} };
    const before = JSON.stringify(schema);
    expect(toStrictJsonSchema(schema)).toBeUndefined();
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('does not close independently composed object fields into an impossible allOf', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'],
      allOf: [{ type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }] };
    expect(toStrictJsonSchema(schema)).toBeUndefined();
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema.allOf[0]).not.toHaveProperty('additionalProperties');
  });

  it('rejects unsupported schema nodes nested in properties, items, anyOf and definitions', () => {
    const unsupported = { type: 'string', not: { const: 'blocked' } };
    const nestedSchemas = [
      unsupported,
      { type: 'array', items: unsupported },
      { anyOf: [{ type: 'string' }, unsupported] },
    ];
    for (const nested of nestedSchemas) {
      expect(toStrictJsonSchema({ type: 'object', properties: { value: nested }, required: ['value'] })).toBeUndefined();
    }
    for (const key of ['$defs', 'definitions']) {
      expect(toStrictJsonSchema({ type: 'object', properties: { value: { $ref: `#/${key}/node` } }, required: ['value'],
        [key]: { node: unsupported } })).toBeUndefined();
    }
  });

  it('keeps supported nested anyOf, definitions and recursive references', () => {
    const schema = { type: 'object', properties: {
      node: { $ref: '#/$defs/node' }, text: { $ref: '#/definitions/text' },
    }, required: ['node', 'text'],
    $defs: { node: { type: 'object', properties: {
      value: { type: 'string' },
      children: { type: 'array', items: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] } },
      root: { $ref: '#' },
    }, required: ['value', 'children', 'root'] } },
    definitions: { text: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
    const strict = toStrictJsonSchema(schema);
    expect(strict).toMatchObject({ additionalProperties: false,
      $defs: { node: { additionalProperties: false, properties: { root: { $ref: '#' },
        children: { items: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] } } } } },
      definitions: schema.definitions,
    });
    expect(schema.$defs.node).not.toHaveProperty('additionalProperties');
  });

  it('only inspects schema nodes, preserving keyword-like parameter names and literal data', () => {
    const literal = { allOf: 'business data', if: 'business data' };
    const schema = { type: 'object', properties: { allOf: { type: 'string' }, if: { type: 'string' } },
      required: ['allOf', 'if'], const: literal, enum: [literal], default: literal, examples: [literal],
      $defs: { allOf: { type: 'string' }, if: { type: 'string' } } };
    expect(toStrictJsonSchema(schema)).toEqual({ ...schema, additionalProperties: false });
  });

  it('rejects root unions and unsafe object siblings without flattening references', () => {
    const object = { type: 'object', properties: {}, required: [] };
    expect(toStrictJsonSchema({ anyOf: [object, object] })).toBeUndefined();
    expect(toStrictJsonSchema({ ...object, anyOf: [object, object] })).toBeUndefined();
    expect(toStrictJsonSchema({ type: 'string' })).toBeUndefined();
    expect(toStrictJsonSchema({ properties: {} })).toBeUndefined();
    for (const value of [
      { type: 'object', properties: {}, required: [], $ref: '#/$defs/other' },
      { type: 'object', properties: {}, required: [], anyOf: [object] },
      { type: 'array', items: [{ type: 'string' }] },
      { anyOf: [] }, { anyOf: {} }, { anyOf: [true] },
    ]) {
      expect(toStrictJsonSchema({ type: 'object', properties: { value }, required: ['value'] })).toBeUndefined();
    }
  });

  it('keeps resource and non-pointer reference semantics in non-strict mode', () => {
    const object = { type: 'object', properties: {}, required: [] };
    expect(toStrictJsonSchema({ ...object, $id: 'https://schema.example.test/root' })).toBeUndefined();
    for (const value of [
      { $ref: 'address' }, { $ref: 'https://schema.example.test/address' }, { $ref: '#address' },
      { $id: 'address', type: 'string' }, { $anchor: 'address', type: 'string' },
      { $dynamicRef: '#address' }, { $recursiveRef: '#' },
    ]) {
      const schema = { type: 'object', properties: { value }, required: ['value'] };
      expect(toStrictJsonSchema(schema)).toBeUndefined();
      expect(sanitizeJsonSchema(schema)).toEqual(schema);
    }
  });

  it('accepts documented string formats and retains ordinary length constraints', () => {
    for (const format of ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']) {
      const schema = { type: 'object', properties: { value: { type: 'string', format, minLength: 1, maxLength: 100 } }, required: ['value'] };
      expect(toStrictJsonSchema(schema)).toEqual({ ...schema, additionalProperties: false });
    }
  });

  it('does not mark unsupported formats or uniqueItems strict', () => {
    for (const value of [{ type: 'string', format: 'uri' }, { type: 'string', format: 'custom-format' },
      { type: 'array', items: { type: 'string' }, uniqueItems: true }]) {
      const schema = { type: 'object', properties: { value }, required: ['value'] };
      expect(toStrictJsonSchema(schema)).toBeUndefined();
      expect(sanitizeJsonSchema(schema)).toEqual(schema);
    }
  });

  it('counts enum values across schema nodes without interpreting literal data as schemas', () => {
    const values = Array.from({ length: 500 }, (_, index) => `v${index}`);
    const schema = { type: 'object', properties: {
      first: { type: 'string', enum: values }, second: { type: 'array', items: { type: 'string', enum: values } },
    }, required: ['first', 'second'] };
    expect(toStrictJsonSchema(schema)).toBeDefined();
    expect(toStrictJsonSchema({ ...schema, $defs: { extra: { enum: ['overflow'] } } })).toBeUndefined();
    const data = { format: 'uri', enum: Array.from({ length: 1_001 }, (_, index) => index), uniqueItems: true };
    const literal = { type: 'object', properties: { format: { type: 'string' }, enum: { type: 'string' } },
      required: ['format', 'enum'], enum: [data], const: data, default: data, examples: [data] };
    expect(toStrictJsonSchema(literal)).toEqual({ ...literal, additionalProperties: false });
  });

  it('falls back beyond the single large enum string limit', () => {
    const values = [...Array.from({ length: 250 }, (_, index) => String(index).padEnd(59, 'x')), 'z'.repeat(250)];
    const schema = (enumValues: string[]) => ({ type: 'object', properties: { value: { type: 'string', enum: enumValues } }, required: ['value'] });
    expect(values.join('')).toHaveLength(15_000);
    expect(toStrictJsonSchema(schema(values))).toBeDefined();
    expect(toStrictJsonSchema(schema([...values.slice(0, -1), 'z'.repeat(251)]))).toBeUndefined();
    expect(toStrictJsonSchema(schema(values.slice(0, 250).map(value => value + 'extra')))).toBeDefined();
  });

  it('enforces the total property and object nesting limits', () => {
    const object = (count: number) => {
      const properties = Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, { type: 'string' }]));
      return { type: 'object', properties, required: Object.keys(properties) };
    };
    expect(toStrictJsonSchema(object(5_000))).toBeDefined();
    expect(toStrictJsonSchema(object(5_001))).toBeUndefined();
    expect(toStrictJsonSchema({ ...object(5_000), $defs: { more: object(1) } })).toBeUndefined();
    let nested: Record<string, unknown> = object(0);
    for (let depth = 1; depth < 10; depth += 1) nested = { type: 'object', properties: { child: nested }, required: ['child'] };
    expect(toStrictJsonSchema(nested)).toBeDefined();
    expect(toStrictJsonSchema({ type: 'object', properties: { child: nested }, required: ['child'] })).toBeUndefined();
  });

  it('counts property, definition, enum and const strings toward the aggregate string limit', () => {
    const schema = (length: number) => ({ type: 'object', properties: { v: { $ref: '#/$defs/d' } }, required: ['v'],
      $defs: { d: { type: 'string', const: 'x'.repeat(length), enum: ['abc'] } },
      description: 'x'.repeat(120_001), default: { properties: 'x'.repeat(120_001) } });
    expect(toStrictJsonSchema(schema(119_995))).toBeDefined();
    expect(toStrictJsonSchema(schema(119_996))).toBeUndefined();
  });
});
