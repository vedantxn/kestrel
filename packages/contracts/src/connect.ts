import { SessionId } from "./ids.js";

/**
 * C2. The connect protocol between CDP clients and the gateway.
 *
 * `connectUrl` is `wss://<host>:<port>/v1/sessions/{id}/cdp?token=<token>`. The same base
 * also serves Chrome's discovery endpoints over `https://`, with addresses rewritten to the
 * public one and the token kept. A header `Authorization: Bearer <token>` is accepted in
 * place of the query parameter. Every released Puppeteer drops the path and query when it
 * discovers over `https://`, so `wss://` is the documented form for both clients.
 *
 * A deployment in local mode (no TLS, for a trusted network only) uses `ws://` and `http://`
 * in the same places.
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
  /**
   * Across all connections on a gateway. When a message would push it over, connections of
   * sessions holding more than their share are closed first (4008); the arriving connection is
   * closed only if its own session is over its share, or nothing else can give way.
   */
  globalBufferBudgetBytes: 1024 * MiB,
  /**
   * A session's share of the global budget (threat model G-03). A session holding more than this
   * stops being read on the side that sent, until it drains below half. A gateway that knows its
   * node's slot count uses the global budget divided by the slots instead of this default.
   */
  sessionBufferShareBytes: 256 * MiB,
  /** A side paused this long is closed as too slow. */
  maxPausedMs: 30_000,
} as const;

export const TOKEN_QUERY_PARAM = "token";

export function cdpBasePath(sessionId: string): string {
  return `/v1/sessions/${sessionId}/cdp`;
}

/** W2. The live-view socket on the gateway; a `view` or `control` token opens it. */
export function livePath(sessionId: string): string {
  return `/v1/sessions/${sessionId}/live`;
}

/** W2. The path on the container's CDP forward that reaches runtimed's live module, and the header naming the mode. */
export const RUNTIME_LIVE_PATH = "/kestrel/live";
export const LIVE_MODE_HEADER = "x-kestrel-live-mode";
export const LiveMode = ["view", "control"] as const;
export type LiveMode = (typeof LiveMode)[number];

/**
 * Where clients reach a deployment. `secure` is false only in local mode, which serves plain
 * HTTP and WebSocket and is meant for a trusted network. `host` is a hostname or an IP address
 * (IPv6 in brackets); `webOrigin` is the origin of the API and the dashboard, with its port when
 * that is not the scheme's default.
 */
export interface PublicEndpoint {
  secure: boolean;
  host: string;
  webOrigin: string;
}

/**
 * Parse a deployment's public base URL, e.g. `https://kestrel.example.com` or
 * `http://192.168.1.10`. Only `http:` and `https:` with no path, query, fragment or user info.
 */
export function parsePublicUrl(url: string): PublicEndpoint {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`the public URL must be http:// or https://: ${url}`);
  if (u.username || u.password)
    throw new Error(`the public URL must not carry user info: ${url}`);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw new Error(
      `the public URL must not have a path, query or fragment: ${url}`,
    );
  if (!u.hostname) throw new Error(`the public URL has no host: ${url}`);
  return {
    secure: u.protocol === "https:",
    host: u.hostname,
    webOrigin: u.origin,
  };
}

/** The public endpoint of a TLS deployment known by its hostname alone. */
export function securePublicEndpoint(hostname: string): PublicEndpoint {
  return parsePublicUrl(`https://${hostname}`);
}

/** A bare hostname names a TLS deployment, as it did before local mode. */
function endpointOf(endpoint: PublicEndpoint | string): PublicEndpoint {
  return typeof endpoint === "string"
    ? securePublicEndpoint(endpoint)
    : endpoint;
}

/** The gateway's base URL for a session's CDP endpoint, without the token. */
export function cdpBaseUrl(
  secure: boolean,
  host: string,
  port: number,
  sessionId: string,
): string {
  return `${secure ? "wss" : "ws"}://${host}:${port}${cdpBasePath(sessionId)}`;
}

/** W1. The viewer page's URL; the token and the socket address travel in the fragment, which never leaves the browser. */
export function buildLiveViewUrl(
  endpointOrHost: PublicEndpoint | string,
  gatewayPort: number,
  sessionId: string,
  token: string,
): string {
  const endpoint = endpointOf(endpointOrHost);
  const ws = `${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${gatewayPort}${livePath(sessionId)}`;
  return `${endpoint.webOrigin}/live/${sessionId}#ws=${encodeURIComponent(ws)}&token=${encodeURIComponent(token)}`;
}

/** The URL placed in `Session.connectUrl`. */
export function buildConnectUrl(
  endpointOrHost: PublicEndpoint | string,
  port: number,
  sessionId: string,
  token: string,
): string {
  const endpoint = endpointOf(endpointOrHost);
  return `${cdpBaseUrl(endpoint.secure, endpoint.host, port, sessionId)}?${TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

export type GatewayRoute =
  | { kind: "browser-socket"; sessionId: SessionId } // .../cdp
  | { kind: "browser-socket-id"; sessionId: SessionId; id: string } // .../cdp/devtools/browser/<id>
  | { kind: "page-socket"; sessionId: SessionId; targetId: string } // .../cdp/devtools/page/<id>
  | { kind: "json-version"; sessionId: SessionId } // .../cdp/json/version[/]
  | { kind: "json-list"; sessionId: SessionId } // .../cdp/json, .../cdp/json/list[/]
  | { kind: "live"; sessionId: SessionId }; // /v1/sessions/<id>/live (W2)

const BASE = /^\/v1\/sessions\/(ses_[0-7][0-9a-hjkmnp-tv-z]{25})\/cdp/;
const LIVE = /^\/v1\/sessions\/(ses_[0-7][0-9a-hjkmnp-tv-z]{25})\/live\/?$/;
const DEVTOOLS_ID = /^[A-Za-z0-9-]{1,128}$/;

/** Classify a request path on the gateway, or null if the gateway does not serve it. */
export function matchGatewayPath(pathname: string): GatewayRoute | null {
  const live = LIVE.exec(pathname);
  if (live) return { kind: "live", sessionId: SessionId.parse(live[1]) };
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
