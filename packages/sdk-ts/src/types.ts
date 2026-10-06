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

export type CaptchaProvider =
  | "recaptcha"
  | "hcaptcha"
  | "turnstile"
  | "cloudflare_challenge"
  | "arkose"
  | "datadome"
  | "perimeterx"
  | "geetest"
  | "aws_waf";

/** Why a solve did not put a token in the page. Hand the CAPTCHA to a person. */
export type CaptchaSolveFailure =
  | "unsupported"
  | "no_details"
  | "solver_error"
  | "solver_unreachable"
  | "timeout"
  | "inject_failed"
  | "budget"
  | "no_solver"
  | "runtime_unsupported";

/**
 * The latest solve of a CAPTCHA still present (sessions created with `captcha.solve`). `solved`
 * means a token was put into the page; the site may still refuse it.
 */
export interface CaptchaSolveState {
  provider: CaptchaProvider;
  status: "solving" | "solved" | "failed";
  at: string;
  reason: CaptchaSolveFailure | null;
}

export interface SessionCaptcha {
  providers: CaptchaProvider[];
  /** When the current, unbroken presence began. */
  since: string;
  /** Sessions created with `captcha.solve`: the latest solve of a CAPTCHA still present. */
  solve: CaptchaSolveState | null;
}

/**
 * `solve: true` sends reCAPTCHA, hCaptcha and Turnstile widgets that show to the deployment's
 * CAPTCHA solver service and puts the token into the page. Refused when the deployment has no
 * solver. The page's URL (without query or fragment) and the widget's site key go to that third
 * party, and the page can tell its callback was called by something other than the widget.
 */
export interface CaptchaOptions {
  solve: boolean;
}

/**
 * How to write `country`, `region`, `city` and `sticky` into the proxy's credentials.
 * `generic` (the default) sends them unchanged.
 */
export type ProxyProvider =
  "generic" | "brightdata" | "oxylabs" | "decodo" | "iproyal";

/** Where a session's traffic should exit, in provider-neutral terms. */
export interface ProxyExit {
  provider?: ProxyProvider | undefined;
  /** ISO 3166-1 alpha-2, uppercase. With `generic` it only declares where the proxy exits. */
  country?: string | undefined;
  /** Region or state, in the provider's spelling. Needs `country` and a provider. */
  region?: string | undefined;
  /** City, in the provider's spelling. Needs `country` and a provider. */
  city?: string | undefined;
  /** A sticky-session id (letters and digits): the same exit address while it is reused. */
  sticky?: string | undefined;
  /** How long a sticky exit is kept, where the provider supports it. */
  stickyMinutes?: number | undefined;
}

/** A session's upstream proxy as stored and returned. The password is never returned. */
export interface SessionProxy extends ProxyExit {
  /** `http://host:port`, `https://host:port` or `socks5://host:port`. */
  server: string;
  /** The username as given, before any provider adapter. */
  username?: string | undefined;
}

/**
 * Send a session's traffic through your own proxy: `http://`, `https://` (TLS to the proxy) or
 * `socks5://`. The proxy resolves hostnames. The password is write-only: the API never stores
 * or returns it.
 */
export interface ProxyConfig extends ProxyExit {
  /** `scheme://host:port`, with an explicit port and no credentials, path or query. */
  server: string;
  /** For authentication to the proxy (HTTP Basic, or SOCKS5 username and password). */
  username?: string | undefined;
  password?: string | undefined;
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
  /** Record the browser's display to video, fetched with `sessions.recording`. */
  recording: boolean;
  metadata: Record<string, string>;
  /** The session's upstream proxy, if it has one. */
  proxy?: SessionProxy | undefined;
  /** The browser's IANA time zone, if one was set or derived from the proxy's exit country. */
  timezone?: string | undefined;
  captcha: CaptchaOptions;
}

/** What `sessions.create` accepts. Every field is optional. */
export interface CreateSessionRequest {
  timeout?: number | undefined;
  idleTimeout?: number | undefined;
  stopOnDisconnect?: boolean | undefined;
  viewport?: Viewport | undefined;
  network?: NetworkPolicy | undefined;
  /** Record the browser's display to video. Default false. */
  recording?: boolean | undefined;
  metadata?: Record<string, string> | undefined;
  /** Send the session's traffic through your own proxy. */
  proxy?: ProxyConfig | undefined;
  /** The browser's IANA time zone, e.g. `Europe/Berlin`. Defaults from the proxy's `country` where it has one clear zone. */
  timezone?: string | undefined;
  /** `{ solve: true }`: solve CAPTCHAs with the deployment's solver service. Default off. */
  captcha?: { solve?: boolean | undefined } | undefined;
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
  /** Filled in when the session ends. */
  usage: {
    browserSeconds: number;
    /** Bytes the browser sent through the egress gateway. */
    egressBytesUp: number;
    /** Bytes the browser received through the egress gateway. */
    egressBytesDown: number;
  };
  /**
   * A CAPTCHA from a known provider is showing on a page, or null. It may already be solved: a
   * solved checkbox stays until the page moves on. Unless `captcha.solve` says `solving` or
   * `solved`, hand a person a control live-view link.
   */
  captcha: SessionCaptcha | null;
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
  | "no_policy"
  | "upstream_blocked"
  | "upstream_unreachable"
  | "upstream_auth_failed"
  | "upstream_refused"
  | "upstream_tls_failed";

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
  | { type: "node.lost"; data: { nodeId: string } }
  | {
      type: "captcha.detected";
      data: {
        provider: CaptchaProvider;
        /** The hostname of the page it is on. */
        host: string | null;
        /** Every provider present after this event. */
        present: CaptchaProvider[];
      };
    }
  | {
      type: "captcha.cleared";
      data: { provider: CaptchaProvider; present: CaptchaProvider[] };
    }
  | {
      type: "captcha.solving";
      data: {
        provider: "recaptcha" | "hcaptcha" | "turnstile";
        host: string | null;
      };
    }
  | {
      type: "captcha.solved";
      data: {
        provider: "recaptcha" | "hcaptcha" | "turnstile";
        host: string | null;
        durationMs: number;
        /** Whether the widget's callback was found and called. */
        callback: boolean;
      };
    }
  | {
      type: "captcha.failed";
      data: {
        provider: CaptchaProvider;
        host: string | null;
        reason: CaptchaSolveFailure;
      };
    };

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

// --- Tokens and live view (W1, W2) ------------------------------------------------------

/** `cdp` re-issues a connect URL; `view` opens live view; `control` opens it with mouse and keyboard. */
export type TokenScope = "cdp" | "view" | "control";

export interface MintTokenRequest {
  scope: TokenScope;
  /** For `view` and `control`: default 10 minutes, at most 1 hour, never past the session's deadline. */
  ttlMs?: number | undefined;
  /** Opens one connection only, and lives at most 5 minutes. */
  singleUse?: boolean | undefined;
}

export interface SessionToken {
  scope: TokenScope;
  token: string;
  /** `cdp`: the wss:// connect URL. `view`/`control`: the viewer page, the token in its fragment. */
  url: string;
  expiresAt: string;
}

// --- /computer (W4) ---------------------------------------------------------------------

/** Coordinates are CSS pixels of the page; a response's `width` and `height` give its size. */
export type ComputerAction =
  | { action: "screenshot" }
  | {
      action: "click";
      x: number;
      y: number;
      button?: "left" | "middle" | "right" | undefined;
      clicks?: number | undefined;
      screenshot?: boolean | undefined;
    }
  | { action: "move"; x: number; y: number; screenshot?: boolean | undefined }
  | {
      action: "scroll";
      x: number;
      y: number;
      dx?: number | undefined;
      dy: number;
      screenshot?: boolean | undefined;
    }
  | { action: "type"; text: string; screenshot?: boolean | undefined }
  | {
      action: "key";
      /** A DOM key name such as `Enter`, `Tab`, `ArrowDown`, or one character. */
      key: string;
      screenshot?: boolean | undefined;
    };

export interface ComputerResponse {
  ok: true;
  /** PNG, base64: for `screenshot`, and for any action that asked for one. */
  screenshot?: string | undefined;
  width: number;
  height: number;
  url: string;
}
