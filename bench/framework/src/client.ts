import {
  ErrorResponse,
  ListEventsResponse,
  Session,
  type CreateSessionRequest,
  type SessionStatus,
} from "@kestrel/contracts";

/** An error the API returned, with its stable code, so a test can branch on it as a client would. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfter?: number,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/**
 * A thin client for the public API (v1 plan: "a thin TypeScript client used by the harness").
 * It speaks the same HTTP a user's script would, and validates every response against the
 * contract, so a drift between the API and its published schema fails the harness.
 */
export class KestrelClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 120_000,
  ) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = ErrorResponse.safeParse(json);
      if (!e.success)
        throw new ApiError(
          res.status,
          "malformed_error",
          text.slice(0, 200),
          false,
        );
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiError(
        res.status,
        e.data.error.code,
        e.data.error.message,
        e.data.error.retryable,
        Number.isFinite(ra) && ra > 0 ? ra : undefined,
      );
    }
    return { status: res.status, json };
  }

  async create(
    body: Partial<CreateSessionRequest> & Record<string, unknown> = {},
  ): Promise<{ session: Session; created: boolean }> {
    const r = await this.call("POST", "/v1/sessions", body);
    return { session: Session.parse(r.json), created: r.status === 201 };
  }

  async get(id: string): Promise<Session> {
    return Session.parse((await this.call("GET", `/v1/sessions/${id}`)).json);
  }

  async stop(id: string): Promise<Session> {
    return Session.parse(
      (await this.call("POST", `/v1/sessions/${id}/stop`)).json,
    );
  }

  async list(query = ""): Promise<Session[]> {
    const r = (await this.call("GET", `/v1/sessions${query}`)).json as {
      data: unknown[];
    };
    return r.data.map((s) => Session.parse(s));
  }

  /** Every event with its data, oldest first. */
  async eventList(id: string): Promise<ListEventsResponse["data"]> {
    return ListEventsResponse.parse(
      (await this.call("GET", `/v1/sessions/${id}/events?limit=1000`)).json,
    ).data;
  }

  async events(id: string): Promise<string[]> {
    return ListEventsResponse.parse(
      (await this.call("GET", `/v1/sessions/${id}/events?limit=1000`)).json,
    ).data.map((e) => e.type);
  }

  /** W1. A token; `url` is the connect URL (cdp) or the viewer page (view, control). */
  async mintToken(
    id: string,
    body: {
      scope: "cdp" | "view" | "control";
      ttlMs?: number;
      singleUse?: boolean;
    },
  ): Promise<{ scope: string; token: string; url: string; expiresAt: string }> {
    return (await this.call("POST", `/v1/sessions/${id}/tokens`, body))
      .json as never;
  }

  /** W4. One `/computer` action. */
  async computer(
    id: string,
    action: Record<string, unknown>,
  ): Promise<{
    ok: true;
    screenshot?: string;
    width: number;
    height: number;
    url: string;
  }> {
    return (await this.call("POST", `/v1/sessions/${id}/computer`, action))
      .json as never;
  }

  /** W3. The recording's bytes, or null when there is none (404). */
  async recording(id: string): Promise<Buffer | null> {
    const res = await fetch(
      new URL(`/v1/sessions/${id}/recording`, this.baseUrl),
      {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new ApiError(
        res.status,
        "recording_failed",
        await res.text(),
        false,
      );
    return Buffer.from(await res.arrayBuffer());
  }

  /** Poll until the session reaches one of `statuses`, or throw. */
  async waitFor(
    id: string,
    statuses: SessionStatus[],
    timeoutMs = 20_000,
    pollMs = 100,
  ): Promise<Session> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.get(id);
      if (statuses.includes(s.status)) return s;
      if (Date.now() > until)
        throw new Error(
          `session ${id} is ${s.status}, wanted ${statuses.join("|")} within ${timeoutMs} ms`,
        );
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
