/**
 * The public API's types, written out by hand so the published package needs nothing from
 * the private `@kestrel/contracts`. `types.test.ts` checks each one against the contract's
 * zod schema at compile time, so a contract change that is not copied here fails the build.
 * All durations are milliseconds and all times are ISO 8601 strings.
 */

export type SessionStatus =
  | "requested"
  | "scheduling"
  | "starting"
  | "ready"
  | "active"
  | "stopping"
  | "stopped"
  | "failed"
  | "timed_out";

/** A session in one of these has ended and never changes again. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "stopped",
  "failed",
  "timed_out",
];

export type EndReason =
  | "client_stop"
  | "client_disconnect"
  | "idle_timeout"
  | "max_lifetime"
  | "browser_crash"
  | "oom"
  | "runtime_crash"
  | "node_lost"
  | "start_timeout"
  | "disk_limit"
  | "node_refused";

/** The page's inner size in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

export interface NetworkPolicy {
  /** If present, only these hostnames may be reached (`*.example.com` matches subdomains). */
  allow?: string[] | undefined;
  /** These hostnames are refused. */
  deny?: string[] | undefined;
}

/** A session's options as the API applied them, defaults filled in. */
export interface SessionOptions {
  /** Maximum lifetime. */
  timeout: number;
  /** End the session after this long with no client attached. */
  idleTimeout: number;
  /** End the session when its last client disconnects. */
  stopOnDisconnect: boolean;
  viewport: Viewport;
  network: NetworkPolicy;
  metadata: Record<string, string>;
}

/** What `sessions.create` accepts. Every field is optional. */
export interface CreateSessionRequest {
  timeout?: number | undefined;
  idleTimeout?: number | undefined;
  stopOnDisconnect?: boolean | undefined;
  viewport?: Viewport | undefined;
  network?: NetworkPolicy | undefined;
  metadata?: Record<string, string> | undefined;
  /**
   * Repeating a create with the same key returns the original session. The SDK makes one
   * up for every call that does not pass one, so its own retries never create two sessions.
   */
  idempotencyKey?: string | undefined;
  /** If the platform is full, the API retries admission for up to this long before answering 503. */
  waitForCapacityMs?: number | undefined;
}

export interface Session {
  id: string;
  status: SessionStatus;
  endReason: EndReason | null;
  createdAt: string;
  readyAt: string | null;
  endedAt: string | null;
  /** A wss:// URL for Playwright, Puppeteer or any CDP client. It embeds a token: treat it as a secret. */
  connectUrl: string | null;
  viewport: Viewport;
  deviceScaleFactor: number;
  options: SessionOptions;
  nodeId: string | null;
  startPath: "hot" | "cold" | null;
  usage: { browserSeconds: number };
}

export interface ListSessionsQuery {
  status?: SessionStatus | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListEventsQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** One page of a list. `nextCursor` is null on the last page. */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export type EgressDenyReason =
  | "blocked_address"
  | "port_not_allowed"
  | "not_in_allow_list"
  | "in_deny_list"
  | "resolve_failed"
  | "connection_cap"
  | "no_policy";

/** An event's type and payload. */
export type EventBody =
  | { type: "session.requested"; data: Record<string, never> }
  | { type: "session.scheduled"; data: { nodeId: string } }
  | { type: "session.starting"; data: Record<string, never> }
  | {
      type: "session.ready";
      data: { startPath: "hot" | "cold"; readyMs: number };
    }
  | { type: "session.attached"; data: { connections: number } }
  | { type: "session.detached"; data: { connections: number } }
  | { type: "session.stopping"; data: { endReason: EndReason } }
  | {
      type: "session.ended";
      data: { endReason: EndReason; status: SessionStatus };
    }
  | {
      type: "egress.denied";
      data: {
        host: string;
        port: number;
        reason: EgressDenyReason;
        /** Denials are aggregated: how many this event stands for. */
        count: number;
      };
    }
  | {
      type: "runtime.crashed";
      data: {
        process: "chrome" | "runtimed" | "xvfb" | "container";
        exitCode: number | null;
        signal: string | null;
      };
    }
  | { type: "node.lost"; data: { nodeId: string } };

/**
 * One entry in a session's timeline. A newer server may send types not listed here; the
 * SDK passes them through unchanged rather than failing, so switch with a default case.
 */
export type SessionEvent = {
  id: string;
  sessionId: string;
  at: string;
} & EventBody;

/** The body of every error the API returns. Branch on `code` and `retryable`. */
export interface ErrorBody {
  code:
    | "unauthorized"
    | "not_found"
    | "invalid_request"
    | "quota_exceeded"
    | "capacity_exhausted"
    | "conflict"
    | "internal";
  message: string;
  retryable: boolean;
  requestId: string;
  /** For `invalid_request`: the request field the error is about. */
  param?: string | undefined;
}
