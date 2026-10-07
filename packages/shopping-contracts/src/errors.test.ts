import { describe, expect, test } from 'bun:test';
import {
  COMMERCE_ERROR_CODES,
  COMMERCE_ERROR_HTTP_STATUS,
  CommerceError,
  commerceErrorResponseSchema,
  commerceErrorSchema,
  type CommerceErrorCode,
} from './errors';

describe('COMMERCE_ERROR_CODES', () => {
  test('contains the eleven agreed codes', () => {
    // Arrange / Act / Assert: the list is the contract, so a change should fail loudly.
    expect([...COMMERCE_ERROR_CODES].sort()).toEqual([
      'authorization_invalid',
      'budget_exceeded',
      'forbidden',
      'idempotency_conflict',
      'invalid_request',
      'not_found',
      'out_of_stock',
      'payment_failed',
      'quote_expired',
      'requote_required',
      'unauthorized',
    ]);
  });

  test('has no duplicates', () => {
    // Arrange / Act / Assert
    expect(new Set(COMMERCE_ERROR_CODES).size).toBe(COMMERCE_ERROR_CODES.length);
  });
});

describe('COMMERCE_ERROR_HTTP_STATUS', () => {
  test('maps every code to a status', () => {
    // Arrange / Act / Assert: a missing entry would render as `undefined` on the wire.
    for (const code of COMMERCE_ERROR_CODES) {
      expect(typeof COMMERCE_ERROR_HTTP_STATUS[code]).toBe('number');
    }
  });

  test('maps every code to a non-2xx status', () => {
    // Arrange / Act / Assert: OcpClient decides success from the status alone, so a
    // 2xx here would be parsed as a success body and fail schema validation.
    for (const code of COMMERCE_ERROR_CODES) {
      const status = COMMERCE_ERROR_HTTP_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test('maps the specific statuses the contract fixes', () => {
    // Arrange / Act / Assert
    expect(COMMERCE_ERROR_HTTP_STATUS.invalid_request).toBe(400);
    expect(COMMERCE_ERROR_HTTP_STATUS.unauthorized).toBe(401);
    expect(COMMERCE_ERROR_HTTP_STATUS.authorization_invalid).toBe(401);
    expect(COMMERCE_ERROR_HTTP_STATUS.payment_failed).toBe(402);
    expect(COMMERCE_ERROR_HTTP_STATUS.forbidden).toBe(403);
    expect(COMMERCE_ERROR_HTTP_STATUS.not_found).toBe(404);
    expect(COMMERCE_ERROR_HTTP_STATUS.quote_expired).toBe(409);
    expect(COMMERCE_ERROR_HTTP_STATUS.requote_required).toBe(409);
    expect(COMMERCE_ERROR_HTTP_STATUS.budget_exceeded).toBe(409);
    expect(COMMERCE_ERROR_HTTP_STATUS.out_of_stock).toBe(409);
    expect(COMMERCE_ERROR_HTTP_STATUS.idempotency_conflict).toBe(409);
  });

  test('keeps payment_failed distinct from the 4xx codes around it', () => {
    // Arrange / Act / Assert: the caller retries differently on 402 than on 409.
    expect(COMMERCE_ERROR_HTTP_STATUS.payment_failed).not.toBe(
      COMMERCE_ERROR_HTTP_STATUS.idempotency_conflict,
    );
    expect(COMMERCE_ERROR_HTTP_STATUS.payment_failed).not.toBe(
      COMMERCE_ERROR_HTTP_STATUS.invalid_request,
    );
  });
});

describe('CommerceError', () => {
  test('derives its status from its code', () => {
    // Arrange / Act
    const error = new CommerceError('quote_expired', 'quote expired at 10:15');

    // Assert: a handler cannot disagree with the code it returned.
    expect(error.status).toBe(409);
    expect(error.code).toBe('quote_expired');
    expect(error.message).toBe('quote expired at 10:15');
  });

  test('is an Error, so it survives a generic catch', () => {
    // Arrange / Act / Assert
    expect(new CommerceError('not_found', 'nope')).toBeInstanceOf(Error);
  });

  test('omits details from the envelope when none were supplied', () => {
    // Arrange / Act
    const error = new CommerceError('out_of_stock', 'sold out');

    // Assert: an explicit `details: undefined` would not survive JSON round-trip.
    expect(Object.keys(error.toResponse().error)).toEqual(['code', 'message']);
  });

  test('includes details when they were supplied', () => {
    // Arrange
    const error = new CommerceError('budget_exceeded', 'over budget', { max_total_minor: 3000 });

    // Act
    const body = error.toResponse();

    // Assert
    expect(body.error.details).toEqual({ max_total_minor: 3000 });
    expect(commerceErrorResponseSchema.parse(body)).toEqual(body);
  });

  test('produces an envelope that validates against the wire schema', () => {
    // Arrange / Act / Assert
    for (const code of COMMERCE_ERROR_CODES) {
      const body = new CommerceError(code, `failed with ${code}`).toResponse();
      expect(commerceErrorResponseSchema.parse(body)).toEqual(body);
    }
  });

  test('rejects a code that is not in the fixed set', () => {
    // Arrange
    const bogus = 'teapot' as CommerceErrorCode;

    // Act / Assert: mapping it would yield an undefined status.
    expect(() => new CommerceError(bogus, 'nope')).toThrow();
  });
});

describe('commerceErrorSchema', () => {
  test('accepts an envelope body with and without details', () => {
    // Arrange / Act / Assert
    expect(commerceErrorSchema.parse({ code: 'not_found', message: 'gone' })).toEqual({
      code: 'not_found',
      message: 'gone',
    });
    expect(
      commerceErrorSchema.parse({ code: 'not_found', message: 'gone', details: { id: 'x' } }),
    ).toEqual({ code: 'not_found', message: 'gone', details: { id: 'x' } });
  });

  test('rejects an empty message', () => {
    // Arrange / Act / Assert: the message is shown to the user, so it must say something.
    expect(() => commerceErrorSchema.parse({ code: 'not_found', message: '' })).toThrow();
  });

  test('rejects an unknown code', () => {
    // Arrange / Act / Assert
    expect(() => commerceErrorSchema.parse({ code: 'teapot', message: 'nope' })).toThrow();
  });

  test('rejects an unknown envelope field', () => {
    // Arrange / Act / Assert
    expect(() =>
      commerceErrorSchema.parse({ code: 'not_found', message: 'gone', trace: 'abc' }),
    ).toThrow();
  });
});

describe('commerceErrorResponseSchema', () => {
  test('requires the error to be nested under an `error` key', () => {
    // Arrange: the correct body, and the same body unwrapped.
    const wrapped = { error: { code: 'not_found', message: 'gone' } };
    const unwrapped = { code: 'not_found', message: 'gone' };

    // Act / Assert
    expect(commerceErrorResponseSchema.parse(wrapped)).toEqual(wrapped);
    expect(() => commerceErrorResponseSchema.parse(unwrapped)).toThrow();
  });
});
