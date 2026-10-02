import {
  HTTP_STATUS_FOR_ERROR,
  RETRYABLE_ERROR,
  type ErrorCode,
} from "@kestrel/contracts";

/** An error the API deliberately returns. Anything else becomes `internal`. */
export class AppError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: {
      param?: string;
      retryAfterSeconds?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.status = HTTP_STATUS_FOR_ERROR[code];
    this.retryable = opts.retryable ?? RETRYABLE_ERROR[code];
  }
}
