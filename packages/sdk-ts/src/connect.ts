import type * as Playwright from "playwright-core";
import type { Browser } from "playwright-core";
import { KestrelError } from "./errors.js";
import type { Sessions } from "./sessions.js";
import type { CreateSessionRequest, Session } from "./types.js";

export interface ConnectOptions extends CreateSessionRequest {
  /** How long Playwright may take to attach over CDP. Default 30 s. */
  connectTimeoutMs?: number | undefined;
}

export interface KestrelBrowser {
  browser: Browser;
  session: Session;
  /** Close the browser connection, then stop the session. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Create a session and attach Playwright to it. If attaching fails, the session is stopped
 * before the error is rethrown: a failed connect must not leave a browser running (and
 * billing) until its idle timeout.
 */
export async function connect(
  sessions: Sessions,
  opts: ConnectOptions = {},
): Promise<KestrelBrowser> {
  const { connectTimeoutMs = 30_000, ...req } = opts;
  const session = await sessions.create(req);
  let browser: Browser;
  try {
    if (!session.connectUrl)
      throw new KestrelError(
        `session ${session.id} is ${session.status} and has no connectUrl`,
      );
    const { chromium } = await loadPlaywright();
    browser = await chromium.connectOverCDP(session.connectUrl, {
      timeout: connectTimeoutMs,
    });
  } catch (e) {
    await sessions.stop(session.id).catch(() => {});
    throw e;
  }

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // The socket may already be gone (the session timed out, or the browser crashed);
      // the session still needs stopping either way.
      await browser.close().catch(() => {});
      await sessions.stop(session.id);
    })());
  return { browser, session, close };
}

/** Loaded only here, so code that never calls `connect()` does not need Playwright installed. */
async function loadPlaywright(): Promise<typeof Playwright> {
  try {
    return await import("playwright-core");
  } catch (e) {
    throw new KestrelError(
      "kestrel.connect() needs Playwright: npm install playwright-core",
      { cause: e },
    );
  }
}
