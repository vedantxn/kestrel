import { ApiError, ConnectionError } from "./errors.js";
import type { ErrorBody } from "./types.js";

export const SDK_VERSION = "1.0.0";

export interface HttpConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  fetch: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal | undefined;
  /**
   * False for a call that is not safe to repeat blindly (a create with no idempotency key): it is
   * then retried only when the API itself answered `retryable`, which means it changed nothing.
   * A call that got no answer, or an answer from something other than the API, may have taken
   * effect, so it is not sent again. Default true.
   */
  idempotent?: boolean | undefined;
  /** Whether this call may retry a `retryable` error. Default: every one may be. */
  retry?: ((err: ApiError) => boolean) | undefined;
}

/** The longest exponential backoff step; a `Retry-After` from the API may ask for longer. */
const MAX_BACKOFF_MS = 8_000;

/**
 * Sends one API call, retrying it when that is safe and useful. Almost every endpoint can be
 * repeated (reads, an idempotent stop, and session creates that carry an idempotency key), so
 * the only question is whether a repeat could succeed: the API says so in `retryable`, and a
 * connection that failed before any answer may simply have been unlucky. The exceptions say so
 * with `idempotent: false`.
 */
export class Http {
  constructor(private readonly config: HttpConfig) {}

  /** A call answered with JSON. */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const { res, value: text } = await this.exchange(method, path, opts, (r) =>
      r.text(),
    );
    try {
      return {
        status: res.status,
        body: (text ? JSON.parse(text) : undefined) as T,
      };
    } catch {
      throw malformed(res, text);
    }
  }

  /**
   * A call answered with a body to stream (a video). Retries happen only until a successful
   * answer starts; the client's timeout covers waiting for that answer, not the download,
   * which may rightly take longer. The caller's `signal` still covers both.
   */
  async stream(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    return (await this.exchange(method, path, opts, async (r) => r)).res;
  }

  private async exchange<T>(
    method: string,
    path: string,
    opts: RequestOptions,
    read: (res: Response) => Promise<T>,
  ): Promise<{ res: Response; value: T }> {
    const url = this.url(path, opts.query);
    for (let attempt = 0; ; attempt++) {
      const timer = new AbortController();
      const t = setTimeout(
        () =>
          timer.abort(
            new DOMException(
              `no answer within ${this.config.timeoutMs} ms`,
              "TimeoutError",
            ),
          ),
        this.config.timeoutMs,
      );
      let res: Response;
      let value: T | undefined;
      let text = "";
      try {
        res = await this.send(method, url, opts, timer.signal);
        if (res.ok) value = await read(res);
        else text = await res.text();
      } catch (e) {
        // The caller cancelled: stop at once, whatever the retry budget says.
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (opts.idempotent === false || attempt >= this.config.maxRetries)
          throw new ConnectionError(
            `${method} ${url.origin}${url.pathname} failed: ${describe(e)}`,
            { cause: e },
          );
        await sleep(this.backoff(attempt), opts.signal);
        continue;
      } finally {
        clearTimeout(t);
      }
      if (res.ok) return { res, value: value as T };
      const err = toApiError(res, text);
      if (
        !err.retryable ||
        attempt >= this.config.maxRetries ||
        (opts.idempotent === false && err.code === "malformed_response") ||
        (opts.retry && !opts.retry(err))
      )
        throw err;
      await sleep(err.retryAfterMs ?? this.backoff(attempt), opts.signal);
    }
  }

  private url(path: string, query: RequestOptions["query"]): URL {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }

  private send(
    method: string,
    url: URL,
    opts: RequestOptions,
    timeout: AbortSignal,
  ): Promise<Response> {
    return this.config.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "user-agent": `kestrel-sdk-ts/${SDK_VERSION}`,
        // Error answers are JSON even where success is not (a video).
        accept: "application/json, */*",
        ...(opts.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  }

  /** Exponential backoff with full jitter, so many clients told "full" do not return together. */
  backoff(attempt: number): number {
    const cap = Math.min(
      MAX_BACKOFF_MS,
      this.config.retryBaseDelayMs * 2 ** attempt,
    );
    return Math.random() * cap;
  }
}

/** Node's fetch says only "fetch failed"; the useful part (ECONNREFUSED, a timeout) is the cause. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = cause?.code ?? cause?.message;
  return typeof detail === "string" ? `${e.message} (${detail})` : e.message;
}

function toApiError(res: Response, text: string): ApiError {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return malformed(res, text);
  }
  const e = (json as { error?: Partial<ErrorBody> } | null)?.error;
  if (
    typeof e?.code !== "string" ||
    typeof e.message !== "string" ||
    typeof e.retryable !== "boolean"
  )
    return malformed(res, text);
  return new ApiError(
    res.status,
    e.code,
    e.message,
    e.retryable,
    typeof e.requestId === "string" ? e.requestId : undefined,
    typeof e.param === "string" ? e.param : undefined,
    retryAfterMs(res.headers.get("retry-after")),
  );
}

/**
 * Not the documented shape: something between us and the API (a proxy, a load balancer)
 * answered. A 502/503/504 from one of those is worth retrying; anything else is not.
 */
function malformed(res: Response, text: string): ApiError {
  return new ApiError(
    res.status,
    "malformed_response",
    text.slice(0, 200) || res.statusText,
    [502, 503, 504].includes(res.status),
    undefined,
    undefined,
    retryAfterMs(res.headers.get("retry-after")),
  );
}

/** `Retry-After` is either whole seconds or an HTTP date (RFC 9110 10.2.3). */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
