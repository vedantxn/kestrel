import {
  ApiKey,
  CreatedApiKey,
  ErrorResponse,
  ListAdminNodesResponse,
  ListApiKeysResponse,
  ListEventsResponse,
  ListSessionsResponse,
  Project,
  Session,
  SessionToken,
  UsageReport,
  type SessionEvent,
  type SessionStatus,
} from "@kestrel/contracts";
import type { z } from "zod";

/**
 * The dashboard's way to the Kestrel API. Server-only: it holds an API key, so it is built per
 * request in a server component, server action or route handler and never sent to a browser.
 * Every response is parsed with the contract it claims to follow.
 */
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Called on a 401: the key was revoked or is wrong. Typically redirects to sign-in. */
  onUnauthorized?: () => never;
  fetch?: typeof fetch;
}

export class KestrelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type KestrelClient = ReturnType<typeof createKestrelClient>;

export function createKestrelClient(opts: ClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function raw(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const res = await doFetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (res.ok) return res;
    if (res.status === 401 && opts.onUnauthorized) opts.onUnauthorized();
    const parsed = ErrorResponse.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new KestrelApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
        )
      : new KestrelApiError(
          res.status,
          "internal",
          `The API answered ${res.status}.`,
        );
  }

  async function call<S extends z.ZodType>(
    schema: S,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const res = await raw(method, path, body);
    return schema.parse(await res.json());
  }

  const enc = encodeURIComponent;
  const query = (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return {
    project: () => call(Project, "GET", "/v1/project"),

    listSessions: (q: {
      status?: SessionStatus | undefined;
      limit?: number;
      cursor?: string | undefined;
    }) => call(ListSessionsResponse, "GET", `/v1/sessions${query(q)}`),

    getSession: (id: string) => call(Session, "GET", `/v1/sessions/${enc(id)}`),

    stopSession: (id: string) =>
      call(Session, "POST", `/v1/sessions/${enc(id)}/stop`),

    /** Every event of a session, oldest first, up to `max`. */
    async events(id: string, max = 2000): Promise<SessionEvent[]> {
      const out: SessionEvent[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(
          ListEventsResponse,
          "GET",
          `/v1/sessions/${enc(id)}/events${query({ limit: 1000, cursor })}`,
        );
        out.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && out.length < max);
      return out;
    },

    mintToken: (
      id: string,
      body: { scope: "view" | "control"; ttlMs?: number },
    ) => call(SessionToken, "POST", `/v1/sessions/${enc(id)}/tokens`, body),

    /** The recording as the API streams it. */
    recording: (id: string) => raw("GET", `/v1/sessions/${enc(id)}/recording`),

    listApiKeys: () => call(ListApiKeysResponse, "GET", "/v1/api-keys"),

    createApiKey: (name: string) =>
      call(CreatedApiKey, "POST", "/v1/api-keys", { name }),

    revokeApiKey: (id: string) =>
      call(ApiKey, "POST", `/v1/api-keys/${enc(id)}/revoke`),

    usage: (days: number) =>
      call(UsageReport, "GET", `/v1/usage${query({ days })}`),

    adminNodes: () => call(ListAdminNodesResponse, "GET", "/v1/admin/nodes"),
  };
}
