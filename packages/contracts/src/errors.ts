import { z } from "zod";

/**
 * C14. The one error shape of every public surface. A client branches on `code` and
 * `retryable`; `message` is for people and may change.
 */
export const ERROR_CODES = [
  "unauthorized",
  "not_found",
  "invalid_request",
  "quota_exceeded",
  "capacity_exhausted",
  "conflict",
  "internal",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS_FOR_ERROR: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  quota_exceeded: 429,
  capacity_exhausted: 503,
  conflict: 409,
  internal: 500,
};

/** Whether a client may repeat the same request unchanged and expect a different outcome. */
export const RETRYABLE_ERROR: Record<ErrorCode, boolean> = {
  unauthorized: false,
  not_found: false,
  invalid_request: false,
  quota_exceeded: true,
  capacity_exhausted: true,
  conflict: true,
  internal: true,
};

export const ApiError = z
  .object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
    /** For `invalid_request`: the request field the error is about, if there is one. */
    param: z.string().optional(),
  })
  .meta({ id: "Error" });
export type ApiError = z.infer<typeof ApiError>;

export const ErrorResponse = z
  .object({ error: ApiError })
  .meta({ id: "ErrorResponse" });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  param?: string,
): ErrorResponse {
  const error: ApiError = {
    code,
    message,
    retryable: RETRYABLE_ERROR[code],
    requestId,
  };
  if (param !== undefined) error.param = param;
  return { error };
}
