import type { ErrorBody, Session } from "./types.js";

/** The base of every error the SDK throws on purpose, so callers can catch them as one. */
export class KestrelError extends Error {
  override name = "KestrelError";
}

/**
 * An error answer from the API. `code` is the API's stable code (or `malformed_response` when
 * the body was not the documented error shape); `message` is for people and may change.
 */
export class ApiError extends KestrelError {
  override name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: ErrorBody["code"] | "malformed_response",
    message: string,
    readonly retryable: boolean,
    readonly requestId: string | undefined,
    readonly param: string | undefined,
    /** From the `Retry-After` header, when the API sent one. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/** The request never got an answer: refused, reset, or past the client's timeout. */
export class ConnectionError extends KestrelError {
  override name = "ConnectionError";
}

/** A session ended while the caller was waiting for it to become ready. */
export class SessionEndedError extends KestrelError {
  override name = "SessionEndedError";

  constructor(readonly session: Session) {
    super(
      `session ${session.id} ended (${session.status}, ${session.endReason ?? "no reason"}) before it was ready`,
    );
  }
}
