import { KestrelError, SessionEndedError } from "./errors.js";
import { sleep, type Http } from "./http.js";
import {
  TERMINAL_STATUSES,
  type ComputerAction,
  type ComputerResponse,
  type CreateSessionRequest,
  type ListEventsQuery,
  type ListSessionsQuery,
  type MintTokenRequest,
  type Page,
  type Session,
  type SessionEvent,
  type SessionToken,
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

export interface LiveViewOptions extends CallOptions {
  /** Let the viewer use mouse and keyboard, not only watch. Default false. */
  control?: boolean | undefined;
  /** Default 10 minutes, at most 1 hour. */
  ttlMs?: number | undefined;
  /** The page can be opened once only. */
  singleUse?: boolean | undefined;
}

const id = (sessionId: string) => encodeURIComponent(sessionId);

/** `/v1/sessions` and everything under it. New per-session endpoints belong here. */
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
   * Mint a token for a running session: `cdp` re-issues a connect URL, `view` and
   * `control` open live view. The result's `url` is ready to use; treat it as a secret.
   */
  async mintToken(
    sessionId: string,
    req: MintTokenRequest,
    opts: CallOptions = {},
  ): Promise<SessionToken> {
    return (
      await this.http.request<SessionToken>(
        "POST",
        `v1/sessions/${id(sessionId)}/tokens`,
        { body: req, signal: opts.signal },
      )
    ).body;
  }

  /** The URL of a page that shows the browser live (and, with `control`, lets a person drive it). */
  async liveViewUrl(
    sessionId: string,
    opts: LiveViewOptions = {},
  ): Promise<string> {
    const token = await this.mintToken(
      sessionId,
      {
        scope: opts.control ? "control" : "view",
        ttlMs: opts.ttlMs,
        singleUse: opts.singleUse,
      },
      opts,
    );
    return token.url;
  }

  /**
   * One screenshot, click, move, scroll, type or key press on the session's current page,
   * no CDP client needed. `screenshot` in the answer is a base64 PNG.
   */
  async computer(
    sessionId: string,
    action: ComputerAction,
    opts: CallOptions = {},
  ): Promise<ComputerResponse> {
    return (
      await this.http.request<ComputerResponse>(
        "POST",
        `v1/sessions/${id(sessionId)}/computer`,
        { body: action, signal: opts.signal },
      )
    ).body;
  }

  /**
   * The session's video (fragmented MP4) as a stream, for a session created with
   * `recording: true`. While the session runs it ends at the latest fragment. For the whole
   * file at once: `await new Response(stream).arrayBuffer()`.
   */
  async recording(
    sessionId: string,
    opts: CallOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.http.stream(
      "GET",
      `v1/sessions/${id(sessionId)}/recording`,
      { signal: opts.signal },
    );
    if (!res.body) throw new KestrelError("the recording answer had no body");
    return res.body;
  }

  /**
   * Node only: download the recording to `path` and return its size in bytes. It is written
   * beside `path` first and renamed when complete, so a failed download leaves no partial
   * file under the name asked for.
   */
  async saveRecording(
    sessionId: string,
    path: string,
    opts: CallOptions = {},
  ): Promise<number> {
    // Imported here so the rest of the SDK still loads where there is no `node:fs`.
    const { createWriteStream } = await import("node:fs");
    const { rename, rm, stat } = await import("node:fs/promises");
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const body = await this.recording(sessionId, opts);
    const partial = `${path}.part`;
    try {
      await pipeline(
        Readable.fromWeb(body as never),
        createWriteStream(partial),
        { signal: opts.signal },
      );
      await rename(partial, path);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
    return (await stat(path)).size;
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
