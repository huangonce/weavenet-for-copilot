import { describe, expect, it } from 'vitest';
import { createRelayRequestError, createRelayStreamError } from '../src/relay/errors';
import { toLanguageModelError } from '../src/copilot/provider';

describe('relay error mapping', () => {
  it('preserves safe structured SSE error fields and maps rate limits', () => {
    const relayError = createRelayStreamError('Claude', {
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      message: 'Too many requests',
      request_id: 'req_123',
    });
    expect(relayError).toMatchObject({
      upstreamType: 'rate_limit_error',
      upstreamCode: 'rate_limit_exceeded',
      requestId: 'req_123',
      rateLimited: true,
    });
    expect(toLanguageModelError(relayError)).toMatchObject({ code: 'Blocked' });
  });

  it.each([
    [401, 'NoPermissions'],
    [403, 'Blocked'],
    [404, 'NotFound'],
    [429, 'Blocked'],
  ])('maps HTTP %i to %s', (status, code) => {
    const relayError = createRelayRequestError(status, '', 'application/json', '{"error":{"message":"failed"}}');
    expect(toLanguageModelError(relayError)).toMatchObject({ code });
  });
});