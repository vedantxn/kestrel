import { KestrelError, SessionEndedError } from "./errors.js";
import { sleep, type Http } from "./http.js";
import {
  TERMINAL_STATUSES,
  type CreateSessionRequest,
  type ListEventsQuery,
  type ListSessionsQuery,
  type Page,
  type Session,
  type SessionEvent,
} from "./types.js";

export interface CallOptions {
  /** Abort the call, including any retries and waits it is in the middle of. */
  signal?: AbortSignal | undefined;
}

export interface WaitOptions extends CallOptions {
  /** Default 60 s. */
  timeoutMs?: number | undefined;
  /** Default 500 ms. */
  pollIntervalMs?: number | undefined;
}

export interface IterEventsOptions extends CallOptions {
  /** Keep polling for new events until the session ends. */
  follow?: boolean | undefined;
  /** How often to poll when following. Default 1 s. */
  pollIntervalMs?: number | undefined;
}

const id = (sessionId: string) => encodeURIComponent(sessionId);

/**
 * `/v1/sessions` and everything under it. New per-session endpoints (tokens, computer,
 * recording) belong here as further methods once their schemas are in `openapi.json`.
 */
export class Sessions {
  constructor(private readonly http: Http) {}

  /**
   * Create a session. The API answers once the browser is ready to connect to. Every call
   * carries an idempotency key, made up here unless the caller passes one, so a retry after
   * a lost answer returns the same session instead of starting a second browser.
   */
  async create(
    req: CreateSessionRequest = {},
    opts: CallOptions = {},
  ): Promise<Session> {
    const body = {
      ...req,
      idempotencyKey: req.idempotencyKey ?? crypto.randomUUID(),
    };
    return (
      await this.http.request<Session>("POST", "v1/sessions", {
        body,
        signal: opts.signal,
      })
    ).body;
  }

  async get(sessionId: string, opts: CallOptions = {}): Promise<Session> {
    return (
      await this.http.request<Session>("GET", `v1/sessions/${id(sessionId)}`, {
        signal: opts.signal,
      })
    ).body;
  }

  /** Newest first. Pass `nextCursor` back as `cursor` for the next page. */
  async list(
    query: ListSessionsQuery = {},
    opts: CallOptions = {},
  ): Promise<Page<Session>> {
    return (
      await this.http.request<Page<Session>>("GET", "v1/sessions", {
        query: { ...query },
        signal: opts.signal,
      })
    ).body;
  }

  /** Idempotent. Returns at once with the session `stopping` (or already ended). */
  async stop(sessionId: string, opts: CallOptions = {}): Promise<Session> {
    return (
      await this.http.request<Session>(
        "POST",
        `v1/sessions/${id(sessionId)}/stop`,
        { signal: opts.signal },
      )
    ).body;
  }

  /** One page of a session's timeline, oldest first. */
  async events(
    sessionId: string,
    query: ListEventsQuery = {},
    opts: CallOptions = {},
  ): Promise<Page<SessionEvent>> {
    return (
      await this.http.request<Page<SessionEvent>>(
        "GET",
        `v1/sessions/${id(sessionId)}/events`,
        { query: { ...query }, signal: opts.signal },
      )
    ).body;
  }

  /**
   * Every event of a session, oldest first; with `follow`, keep polling until it ends.
   *
   * The API gives no cursor on the last page, so to poll for more this keeps the last cursor
   * it was given and re-reads from there, skipping events it has already yielded.
   */
  async *iterEvents(
    sessionId: string,
    opts: IterEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    let cursor: string | undefined;
    let seen = new Set<string>();
    let ended = false;
    for (;;) {
      const page = await this.events(
        sessionId,
        { cursor, limit: 1000 },
        { signal: opts.signal },
      );
      for (const e of page.data) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (e.type === "session.ended") ended = true;
        yield e;
      }
      if (page.nextCursor) {
        // The next page starts after everything already seen.
        cursor = page.nextCursor;
        seen = new Set();
        continue;
      }
      if (!opts.follow || ended) return;
      await sleep(opts.pollIntervalMs ?? 1000, opts.signal);
    }
  }

  /**
   * Poll until the session can be connected to (`ready` or `active`). Throws
   * `SessionEndedError` if it ends first. `create` already waits for this; use it for a
   * session created elsewhere.
   */
  async waitUntilReady(
    sessionId: string,
    opts: WaitOptions = {},
  ): Promise<Session> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.get(sessionId, opts);
      if (s.status === "ready" || s.status === "active") return s;
      if (TERMINAL_STATUSES.includes(s.status)) throw new SessionEndedError(s);
      if (Date.now() >= until)
        throw new KestrelError(
          `session ${sessionId} is still ${s.status} after ${timeoutMs} ms`,
        );
      await sleep(opts.pollIntervalMs ?? 500, opts.signal);
    }
  }
}
