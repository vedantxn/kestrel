import {
  connect,
  type ConnectOptions,
  type KestrelBrowser,
} from "./connect.js";
import { KestrelError } from "./errors.js";
import { Http } from "./http.js";
import { Sessions } from "./sessions.js";

export interface KestrelOptions {
  /** Default: `KESTREL_API_KEY`. */
  apiKey?: string | undefined;
  /** Default: `KESTREL_URL`, then `http://localhost:8080` (a local self-hosted API). */
  baseUrl?: string | undefined;
  /** Per HTTP attempt. Default 120 s, longer than a create that waits for capacity. */
  timeoutMs?: number | undefined;
  /** Retries of a retryable failure, after the first attempt. Default 3. */
  maxRetries?: number | undefined;
  /** First backoff step when the API sends no `Retry-After`. Default 500 ms. */
  retryBaseDelayMs?: number | undefined;
  /** A `fetch` to use instead of the global one (a proxy agent, a test double). */
  fetch?: typeof fetch | undefined;
}

export const DEFAULT_BASE_URL = "http://localhost:8080";

function env(name: string): string | undefined {
  return typeof process === "undefined"
    ? undefined
    : process.env[name] || undefined;
}

/**
 * The Kestrel API client.
 *
 * ```ts
 * const kestrel = new Kestrel();
 * const { browser, close } = await kestrel.connect();
 * const page = browser.contexts()[0]!.pages()[0]!;
 * await page.goto("https://example.com");
 * await close();
 * ```
 */
export class Kestrel {
  readonly sessions: Sessions;
  readonly baseUrl: string;

  constructor(opts: KestrelOptions = {}) {
    const apiKey = opts.apiKey ?? env("KESTREL_API_KEY");
    if (!apiKey)
      throw new KestrelError(
        "No API key: pass { apiKey } or set KESTREL_API_KEY",
      );
    // Paths are joined relative to the base, so a base with a path prefix keeps it.
    const base = opts.baseUrl ?? env("KESTREL_URL") ?? DEFAULT_BASE_URL;
    this.baseUrl = base.endsWith("/") ? base : `${base}/`;
    const http = new Http({
      apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 3,
      retryBaseDelayMs: opts.retryBaseDelayMs ?? 500,
      fetch: opts.fetch ?? globalThis.fetch,
    });
    this.sessions = new Sessions(http);
  }

  /**
   * Create a session and return a Playwright `Browser` attached to it. Needs the
   * `playwright-core` (or `playwright`) package. `close()` closes the browser and stops
   * the session.
   */
  connect(opts: ConnectOptions = {}): Promise<KestrelBrowser> {
    return connect(this.sessions, opts);
  }
}
