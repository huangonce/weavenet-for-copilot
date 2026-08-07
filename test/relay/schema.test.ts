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
