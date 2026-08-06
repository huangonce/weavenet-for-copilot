import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createRelayRequestError, createRelayStreamError } from '../../src/relay/errors';
import {
  describeConnectionTestError,
  sanitizeLanguageModelError,
  toLanguageModelError,
} from '../../src/copilot/provider';

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
    const displayError = toLanguageModelError(relayError) as Error & { cause?: unknown; code?: string };
    expect(displayError).toMatchObject({
      code: 'Blocked',
      message: 'The request was rate- or quota-limited. Please try again later or check the account quota.',
    });
    expect(displayError.message).not.toContain('Too many requests');
    expect(displayError.cause).toBeUndefined();
  });

  it('hides upstream details from non-quota stream failures', () => {
    const relayError = createRelayStreamError('Responses', {
      type: 'server_error',
      message: 'sensitive upstream stream failure',
      request_id: 'req-private',
    });
    const displayError = toLanguageModelError(relayError) as Error & { cause?: unknown };
    expect(displayError.message).toBe(
      'The model response stream ended unexpectedly. Please try again; if the problem persists, check the service status.',
    );
    expect(displayError.message).not.toContain('sensitive upstream stream failure');
    expect(displayError.cause).toBeUndefined();
  });

  it.each([
    [401, 'NoPermissions'],
    [402, 'Blocked'],
    [403, 'Blocked'],
    [404, 'NotFound'],
    [429, 'Blocked'],
  ])('maps HTTP %i to %s', (status, code) => {
    const relayError = createRelayRequestError(status, '', 'application/json', '{"error":{"message":"failed"}}');
    expect(toLanguageModelError(relayError)).toMatchObject({ code });
  });

  it('uses the original upstream detail only for quota classification', () => {
    const relayError = createRelayRequestError(
      400,
      'Bad Request',
      'application/json',
      '{"error":{"message":"quota exceeded"}}',
    );
    expect(toLanguageModelError(relayError)).toMatchObject({
      code: 'Blocked',
      message: '[400] The request format is invalid. Check the model configuration or request parameters.',
    });
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
    const displayError = toLanguageModelError(relayError) as Error & { cause?: unknown; code?: string };
    expect(displayError).toMatchObject({
      code: 'Unknown',
      message: '[502] The gateway could not reach the upstream model service. Please try again later.',
    });
    expect(displayError.message).not.toContain('ea867033-a931-4628-8016-188272427b69');
    expect(displayError.message).not.toContain('Upstream request failed');
    expect(displayError.cause).toBeUndefined();
  });

  it.each([
    [400, 'The request format is invalid'],
    [401, 'Authentication failed'],
    [402, 'insufficient balance'],
    [403, 'The request was denied'],
    [404, 'The endpoint or model was not found'],
    [413, 'The request is too large'],
    [422, 'unsupported parameters'],
    [429, 'Too many requests'],
    [500, 'internal error'],
    [503, 'temporarily overloaded or unavailable'],
    [504, 'timed out waiting'],
  ])('maps HTTP %i to a concise display message', (status, expected) => {
    const relayError = createRelayRequestError(
      status,
      'Provider Error',
      'application/json',
      '{"error":{"message":"sensitive upstream detail","code":"provider_error"}}',
      'req-private',
    );
    const displayError = toLanguageModelError(relayError) as Error & { cause?: unknown };
    expect(displayError.message).toContain(`[${status}]`);
    expect(displayError.message).toContain(expected);
    expect(displayError.message).not.toContain('sensitive upstream detail');
    expect(displayError.message).not.toContain('req-private');
    expect(displayError.cause).toBeUndefined();
  });

  it('explains a WebSocket-only endpoint instead of echoing the upgrade error', () => {
    const relayError = createRelayRequestError(
      426,
      'Upgrade Required',
      'application/json',
      '{"error":{"message":"WebSocket upgrade required (Upgrade: websocket)","type":"invalid_request_error"}}',
    );
    expect(relayError.message).toContain('served over WebSocket');
    expect(relayError.message).toContain('Chat Completions');
    expect(relayError).toMatchObject({ status: 426, upstreamType: 'invalid_request_error' });
    expect(toLanguageModelError(relayError).message).toContain('only supports WebSocket');
    expect(toLanguageModelError(relayError).message).toContain('Chat Completions');
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

describe('sanitizeLanguageModelError', () => {
  it('strips the stack and renames LanguageModelError so RPC deserialization cannot rebuild a noisy stack', () => {
    const error = vscode.LanguageModelError.NoPermissions('身份验证失败。请检查此连接的 API Key。');
    // The real VS Code LanguageModelError constructor sets this name; the mock
    // does not, so simulate it to lock in the sanitizer behavior.
    error.name = 'LanguageModelError';
    expect(error.stack).toBeDefined();

    sanitizeLanguageModelError(error);

    expect(error).toBeInstanceOf(vscode.LanguageModelError);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('身份验证失败。请检查此连接的 API Key。');
    expect(error.code).toBe('NoPermissions');
    expect(error.stack).toBeUndefined();
  });

  it('drops the stack of plain errors but keeps their name and message', () => {
    const error = new Error('boom');
    expect(error.stack).toBeDefined();
    sanitizeLanguageModelError(error);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('boom');
    expect(error.stack).toBeUndefined();
  });

  it('passes cancellation errors through untouched', () => {
    const cancelled = new vscode.CancellationError();
    sanitizeLanguageModelError(cancelled);
    expect(cancelled).toBeInstanceOf(vscode.CancellationError);
    expect(cancelled.stack).toBeDefined();
  });

  it('passes non-Error values through untouched', () => {
    expect(sanitizeLanguageModelError('oops')).toBe('oops');
    expect(sanitizeLanguageModelError(undefined)).toBeUndefined();
  });

  it('sanitizes the relay display error end to end', () => {
    const relayError = createRelayRequestError(
      503,
      'Service Unavailable',
      'application/json',
      '{"error":{"message":"overloaded"}}',
    );
    const sanitized = sanitizeLanguageModelError(toLanguageModelError(relayError)) as Error;
    expect(sanitized.message).toBe('[503] The model service is temporarily overloaded or unavailable. Please try again shortly.');
    expect(sanitized.stack).toBeUndefined();
  });
});