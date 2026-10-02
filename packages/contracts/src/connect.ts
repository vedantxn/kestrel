import { SessionId } from "./ids.js";

/**
 * C2. The connect protocol between CDP clients and the gateway.
 *
 * `connectUrl` is `wss://<host>:<port>/v1/sessions/{id}/cdp?token=<token>`. The same base
 * also serves Chrome's discovery endpoints over `https://`, with addresses rewritten to the
 * public one and the token kept. A header `Authorization: Bearer <token>` is accepted in
 * place of the query parameter. Every released Puppeteer drops the path and query when it
 * discovers over `https://`, so `wss://` is the documented form for both clients.
 */

/** Close codes the gateway uses (C7 in the v1 plan). 1012 is the standard "service restart". */
export const CLOSE_CODES = {
  tokenInvalid: 4001,
  sessionEnded: 4002,
  notOnThisNode: 4003,
  limitExceeded: 4008,
  tooSlow: 4009,
  gatewayRestarting: 1012,
} as const;

const MiB = 1024 * 1024;

export const CONNECT_LIMITS = {
  /** Playwright's and Puppeteer's own limit; raised from the `ws` library's 100 MiB default on both sides. */
  maxMessageBytes: 256 * MiB,
  maxConnectionsPerSession: 8,
  pingIntervalMs: 30_000,
  /** A peer that answers none of this many pings is dropped. */
  missedPingsBeforeDrop: 2,
  /** Relay: pause the other side when one side's send buffer passes this... */
  pauseAtBufferedBytes: 8 * MiB,
  /** ...and resume when it drains below this. */
  resumeAtBufferedBytes: 1 * MiB,
  /** Across all connections on a gateway; the connection that pushes it over is closed. */
  globalBufferBudgetBytes: 1024 * MiB,
  /** A side paused this long is closed as too slow. */
  maxPausedMs: 30_000,
} as const;

export const TOKEN_QUERY_PARAM = "token";

export function cdpBasePath(sessionId: string): string {
  return `/v1/sessions/${sessionId}/cdp`;
}

/** The URL placed in `Session.connectUrl`. */
export function buildConnectUrl(
  host: string,
  port: number,
  sessionId: string,
  token: string,
): string {
  return `wss://${host}:${port}${cdpBasePath(sessionId)}?${TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

export type GatewayRoute =
  | { kind: "browser-socket"; sessionId: SessionId } // .../cdp
  | { kind: "browser-socket-id"; sessionId: SessionId; id: string } // .../cdp/devtools/browser/<id>
  | { kind: "page-socket"; sessionId: SessionId; targetId: string } // .../cdp/devtools/page/<id>
  | { kind: "json-version"; sessionId: SessionId } // .../cdp/json/version[/]
  | { kind: "json-list"; sessionId: SessionId }; // .../cdp/json, .../cdp/json/list[/]

const BASE = /^\/v1\/sessions\/(ses_[0-7][0-9a-hjkmnp-tv-z]{25})\/cdp/;
const DEVTOOLS_ID = /^[A-Za-z0-9-]{1,128}$/;

/** Classify a request path on the gateway, or null if the gateway does not serve it. */
export function matchGatewayPath(pathname: string): GatewayRoute | null {
  const m = BASE.exec(pathname);
  if (!m) return null;
  const sessionId = SessionId.parse(m[1]);
  const rest = pathname.slice(m[0].length);
  if (rest === "" || rest === "/") return { kind: "browser-socket", sessionId };
  if (rest === "/json/version" || rest === "/json/version/")
    return { kind: "json-version", sessionId };
  if (
    rest === "/json" ||
    rest === "/json/" ||
    rest === "/json/list" ||
    rest === "/json/list/"
  )
    return { kind: "json-list", sessionId };
  const dev = /^\/devtools\/(browser|page)\/([^/]+)$/.exec(rest);
  if (dev && DEVTOOLS_ID.test(dev[2] as string)) {
    return dev[1] === "browser"
      ? { kind: "browser-socket-id", sessionId, id: dev[2] as string }
      : { kind: "page-socket", sessionId, targetId: dev[2] as string };
  }
  return null;
}

/** Remove the token from a URL or query string before it is logged (C13: redact query strings). */
export function redactToken(urlOrPath: string): string {
  return urlOrPath.replace(/([?&]token=)[^&#]*/g, "$1[redacted]");
}
