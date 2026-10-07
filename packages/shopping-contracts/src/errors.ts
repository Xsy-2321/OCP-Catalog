/**
 * Error codes and the error envelope for the demo commerce endpoints.
 *
 * The envelope matches the one already used by the existing OCP examples and
 * CLI — `{ "error": { "code", "message", "details?" } }` — so a caller that
 * already handles OCP errors needs no special case.
 *
 * The HTTP status matters as much as the code: the existing `OcpClient` decides
 * success or failure from the HTTP status and only then parses the body against
 * a schema. A commerce endpoint must therefore return schema-correct JSON with a
 * 2xx status on success, and a non-2xx status for every error — never a 200
 * carrying an error body.
 */
import { z } from 'zod';

/** The fixed set of commerce error codes. Callers branch on these, never on prose. */
export const COMMERCE_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'quote_expired',
  'requote_required',
  'budget_exceeded',
  'out_of_stock',
  'authorization_invalid',
  'idempotency_conflict',
  'payment_failed',
  'not_found',
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

export const commerceErrorCodeSchema = z.enum(COMMERCE_ERROR_CODES);

/**
 * HTTP status for each code.
 *
 * `payment_failed` is 402 because the request was well formed and authorized but
 * the payment step itself did not succeed — collapsing it into 400 or 409 would
 * lose the distinction the caller needs in order to decide whether to retry.
 */
export const COMMERCE_ERROR_HTTP_STATUS: Readonly<Record<CommerceErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  authorization_invalid: 401,
  payment_failed: 402,
  forbidden: 403,
  not_found: 404,
  quote_expired: 409,
  requote_required: 409,
  budget_exceeded: 409,
  out_of_stock: 409,
  idempotency_conflict: 409,
};

export const commerceErrorSchema = z
  .object({
    code: commerceErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * The envelope body: the shape of `error` inside `CommerceErrorResponse`.
 *
 * Named `...Payload` rather than `CommerceError` because that name belongs to
 * the thrown class below — one is data, the other is an in-process error, and
 * having a type and a value share a name here would make every import site
 * ambiguous about which one it meant.
 */
export type CommerceErrorPayload = z.infer<typeof commerceErrorSchema>;

export const commerceErrorResponseSchema = z
  .object({ error: commerceErrorSchema })
  .strict();

export type CommerceErrorResponse = z.infer<typeof commerceErrorResponseSchema>;

/**
 * In-process error carrying a wire error code.
 *
 * Merchant code throws this and the HTTP layer renders it. Keeping the code on
 * the error means a handler cannot accidentally invent a status code that
 * disagrees with the code it returns.
 */
export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(code: CommerceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    const status = COMMERCE_ERROR_HTTP_STATUS[code];
    // The type says this cannot happen, but a code can still arrive as a plain
    // string from parsed JSON or a JS caller. Without this guard the failure is a
    // response with a literal `undefined` status, which surfaces as a crash in
    // the HTTP layer rather than as the wrong code it actually is.
    if (typeof status !== 'number') {
      throw new TypeError(`unknown commerce error code: ${String(code)}`);
    }
    this.name = 'CommerceError';
    this.code = code;
    this.details = details;
    this.status = status;
  }

  /** Renders this error as the wire envelope. */
  toResponse(): CommerceErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
