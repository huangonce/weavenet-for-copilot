import { describe, expect, it } from 'vitest';
import { sanitizeJsonSchema } from '../../src/relay/schema';

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
});
