import { describe, expect, it } from 'vitest';
import { createRelayRequestError, createRelayStreamError } from '../../src/relay/errors';
import { describeConnectionTestError, toLanguageModelError } from '../../src/copilot/provider';

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

  it('preserves a gateway request ID when the JSON error omits one', () => {
    const relayError = createRelayRequestError(
      502,
      'Bad Gateway',
      'application/json',
      '{"error":{"message":"Upstream request failed","type":"upstream_error"}}',
      'ea867033-a931-4628-8016-188272427b69',
    );
    expect(relayError).toMatchObject({
      status: 502,
      upstreamType: 'upstream_error',
      requestId: 'ea867033-a931-4628-8016-188272427b69',
    });
    expect(toLanguageModelError(relayError).message).toContain('[ea867033-a931-4628-8016-188272427b69]');
  });

  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [404, 'notFound'],
    [429, 'rateLimited'],
    [502, 'server'],
  ])('classifies HTTP %i connection test diagnostics', (status, category) => {
    const relayError = createRelayRequestError(status, '', 'application/json', '{"error":{"message":"failed"}}', 'req_test');
    expect(describeConnectionTestError(relayError)).toMatchObject({ category, status, responseType: 'json', requestId: 'req_test' });
  });
});