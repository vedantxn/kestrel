import {
  request as httpRequest,
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  CLOSE_CODES,
  CONNECT_LIMITS,
  LIVE_MODE_HEADER,
  PROOF_HEADER,
  RUNTIME_LIVE_PATH,
  TOKEN_QUERY_PARAM,
  matchGatewayPath,
  redactToken,
  type Attachment,
  type GatewayRoute,
  cdpBaseUrl,
} from "@kestrel/contracts";
import {
  SpentTokens,
  systemClock,
  type Clock,
  type Logger,
  type TokenVerifier,
} from "@kestrel/shared";
import WebSocket, { WebSocketServer } from "ws";
import { BufferBudget, FailureLimiter, sessionShare } from "./budget.js";
import type { GatewayMetrics } from "./metrics.js";
import { Relay, type Limits } from "./relay.js";
import type { RouteEntry, RouteTable } from "./routes.js";
import type { TlsMaterial } from "./tls.js";

export interface GatewayOptions {
  nodeId: string;
  /** What clients are told to connect to when discovery rewrites addresses. */
  publicHostname: string;
  publicPort: number;
  /** False in local mode: discovery then hands out `ws://` addresses. Defaults to true. */
  publicSecure?: boolean;
  verifier: TokenVerifier;
  table: RouteTable;
  log: Logger;
  metrics: GatewayMetrics;
  /** Null serves plain HTTP: for tests only. */
  tls: TlsMaterial | null;
  limits?: Partial<Limits>;
  /**
   * The node's slot count. Each session's share of the buffer budget is the budget divided by
   * it, unless `limits.sessionBufferShareBytes` is given (threat model G-03).
   */
  slots?: number;
  clock?: Clock;
  /** Called with the full attachment snapshot whenever it changes (G12). */
  onAttachments?: (attachments: Attachment[]) => void;
  /** Threat model G-13. */
  maxPendingHandshakes?: number;
  authFailuresPerMinute?: number;
  /** How long to wait for the container before giving up on a connection. */
  upstreamTimeoutMs?: number;
  routeExpirySweepMs?: number;
}

type Auth =
  | {
      ok: true;
      route: GatewayRoute;
      entry: RouteEntry;
      token: string;
      scope: "cdp" | "view" | "control";
    }
  | { ok: false; close: number; status: number; message: string };

/**
 * W1-W4, C1-C8. Terminates TLS, verifies tokens with the API's public key alone, and relays
 * CDP between a client and the session's container, looked up in a local route table. It never
 * parses CDP, and it works with the API and the database down.
 */
export class Gateway {
  private server: Server | undefined;
  private readonly wss: WebSocketServer;
  private relays = new Map<string, Set<Relay>>();
  /** W2. View-only live sockets: they must not keep a session alive (HLD 4.1), so they are left out of attachments. */
  private passive = new WeakSet<Relay>();
  /** W1. Single-use tokens already spent on this gateway. */
  private spent = new SpentTokens();
  private pendingHandshakes = 0;
  private draining = false;
  private sweep: NodeJS.Timeout | undefined;
  private readonly limits: Limits;
  private readonly clock: Clock;
  readonly budget: BufferBudget;
  private readonly failures: FailureLimiter;

  constructor(private readonly o: GatewayOptions) {
    this.limits = { ...CONNECT_LIMITS, ...o.limits } as Limits;
    this.limits.sessionBufferShareBytes = sessionShare({
      globalBytes: this.limits.globalBufferBudgetBytes,
      defaultBytes: CONNECT_LIMITS.sessionBufferShareBytes,
      slots: o.slots,
      configuredBytes: o.limits?.sessionBufferShareBytes,
    });
    this.clock = o.clock ?? systemClock;
    this.budget = new BufferBudget(
      this.limits.globalBufferBudgetBytes,
      this.limits.sessionBufferShareBytes,
    );
    o.metrics.share.set(this.budget.shareBytes);
    this.failures = new FailureLimiter(o.authFailuresPerMinute ?? 30);
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: this.limits.maxMessageBytes,
    });
    o.table.onRemoved = (ids) =>
      ids.forEach((id) =>
        this.closeSession(id, CLOSE_CODES.sessionEnded, "session ended"),
      );
  }

  // --- lifecycle ----------------------------------------------------------------------------

  async start(listen: {
    host: string;
    port: number;
    reusePort?: boolean;
  }): Promise<AddressInfo> {
    const handler = (req: IncomingMessage, res: ServerResponse): void =>
      void this.onRequest(req, res);
    const common = {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 5_000,
    };
    this.server = this.o.tls
      ? createHttpsServer(
          {
            ...common,
            key: this.o.tls.key,
            cert: this.o.tls.cert,
            minVersion: "TLSv1.2",
            handshakeTimeout: 10_000,
          } as never,
          handler,
        )
      : createHttpServer(common, handler);
    this.server.on(
      "upgrade",
      (req, socket, head) => void this.onUpgrade(req, socket, head),
    );
    this.server.on("clientError", (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(
        {
          host: listen.host,
          port: listen.port,
          ...(listen.reusePort ? { reusePort: true } : {}),
        },
        resolve,
      );
    });
    this.sweep = setInterval(
      () => this.expireRoutes(),
      this.o.routeExpirySweepMs ?? 5_000,
    );
    this.sweep.unref();
    return this.server.address() as AddressInfo;
  }

  /** Swap in a renewed certificate without dropping a connection. */
  setTls(m: TlsMaterial): void {
    (
      this.server as unknown as
        { setSecureContext?: (o: object) => void } | undefined
    )?.setSecureContext?.({ key: m.key, cert: m.cert });
  }

  /**
   * W4. Stop accepting, let existing connections finish for up to `drainMs`, then tell the rest
   * the gateway is restarting (1012). A deploy that replaces this process on the same port
   * (SO_REUSEPORT) therefore does not cut running scripts.
   */
  async stop(drainMs = 0): Promise<void> {
    this.draining = true;
    clearInterval(this.sweep);
    const closed = new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
    const until = Date.now() + drainMs;
    while (this.connectionCount() > 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50));
    for (const id of [...this.relays.keys()])
      this.closeSession(
        id,
        CLOSE_CODES.gatewayRestarting,
        "gateway restarting",
      );
    this.server?.closeAllConnections();
    await closed;
  }

  connectionCount(): number {
    let n = 0;
    for (const set of this.relays.values()) n += set.size;
    return n;
  }

  attachments(): Attachment[] {
    return [...this.relays]
      .map(([sessionId, s]) => ({
        sessionId: sessionId as Attachment["sessionId"],
        connections: [...s].filter((r) => !this.passive.has(r)).length,
      }))
      .filter((a) => a.connections > 0);
  }

  /** Point-in-time buffer figures for `/metrics` (C6, G-03). */
  updateBufferMetrics(): void {
    this.o.metrics.buffered.set(this.budget.usedBytes);
    this.o.metrics.largestSession.set(this.budget.largestSessionBytes);
    this.o.metrics.overShare.set(this.budget.sessionsOverShare().length);
  }

  /**
   * C6, G-03. Room in the budget for a message a session's connection is about to queue. When
   * the global budget is full, the session that is over its own share gives way: the arriving
   * connection if its session is over its share, else connections of the sessions furthest over
   * theirs, the fullest first, until the message fits. A session within its share is refused
   * only if nothing else can give way (more sessions than slots, or a share set too high).
   */
  private admit(sessionId: string, bytes: number): boolean {
    const b = this.budget;
    if (b.reserve(sessionId, bytes)) return true;
    const refuse = (reason: string): boolean => {
      this.o.metrics.budgetCloses.inc({ reason });
      return false;
    };
    if (b.sessionBytes(sessionId) + bytes > b.shareBytes)
      return refuse("over_share");
    for (const victim of b.sessionsOverShare()) {
      const relays = [...(this.relays.get(victim) ?? [])]
        .filter((r) => r.queuedBytes > 0)
        .sort((x, y) => y.queuedBytes - x.queuedBytes);
      for (const r of relays) {
        this.o.log.warn(
          { session: victim, queuedBytes: r.queuedBytes, for: sessionId },
          "closing a connection over its session's buffer share",
        );
        r.evict();
        this.o.metrics.budgetCloses.inc({ reason: "evicted" });
        if (b.reserve(sessionId, bytes)) return true;
      }
    }
    return refuse("global");
  }

  /** Close every connection of a session, e.g. because its route is gone. */
  closeSession(sessionId: string, code: number, reason: string): void {
    for (const r of [...(this.relays.get(sessionId) ?? [])])
      r.shutdown(code, reason);
  }

  // --- authentication -----------------------------------------------------------------------

  private async authenticate(req: IncomingMessage): Promise<Auth> {
    const url = new URL(req.url ?? "/", "http://gateway");
    const route = matchGatewayPath(url.pathname);
    if (!route)
      return {
        ok: false,
        close: CLOSE_CODES.tokenInvalid,
        status: 404,
        message: "not found",
      };

    const bearer = req.headers.authorization;
    const token =
      url.searchParams.get(TOKEN_QUERY_PARAM) ??
      (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice(7).trim()
        : "");
    // W1: the CDP paths take a `cdp` token; live view takes `view` or `control`.
    const scopes =
      route.kind === "live"
        ? (["view", "control"] as const)
        : (["cdp"] as const);
    const v = token
      ? await this.o.verifier.verify(token, this.clock.now(), scopes)
      : ({ ok: false, reason: "invalid" } as const);
    if (!v.ok || v.claims.sub !== route.sessionId) {
      return {
        ok: false,
        close: CLOSE_CODES.tokenInvalid,
        status: 401,
        message: "token invalid or expired",
      };
    }
    if (v.claims.nod !== this.o.nodeId) {
      return {
        ok: false,
        close: CLOSE_CODES.notOnThisNode,
        status: 421,
        message: "session is not on this node",
      };
    }
    const entry = this.o.table.get(route.sessionId);
    if (!entry || entry.notAfter * 1000 < this.clock.now()) {
      return {
        ok: false,
        close: CLOSE_CODES.sessionEnded,
        status: 410,
        message: "session ended",
      };
    }
    // A genuine token names the project the route belongs to; anything else is not a token for this session.
    if (entry.projectId !== v.claims.prj) {
      return {
        ok: false,
        close: CLOSE_CODES.tokenInvalid,
        status: 401,
        message: "token invalid or expired",
      };
    }
    // Spent last, so a token is used up only by a request that would otherwise have been served.
    if (v.claims.once && v.claims.jti) {
      if (!this.spent.spend(v.claims.jti, v.claims.exp, this.clock.now()))
        return {
          ok: false,
          close: CLOSE_CODES.tokenInvalid,
          status: 401,
          message: "token already used",
        };
    }
    return { ok: true, route, entry, token, scope: v.claims.scope };
  }

  private remote(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  // --- plain HTTP: health and discovery -------------------------------------------------------

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      connection: "close",
    });
    res.end(text);
  }

  private async onRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const path = new URL(req.url ?? "/", "http://gateway").pathname;
      if (path === "/healthz")
        return this.json(res, 200, {
          status: this.draining ? "draining" : "ok",
        });
      if (this.failures.blocked(this.remote(req)))
        return this.json(res, 429, { error: "too many failed attempts" });

      const a = await this.authenticate(req);
      if (!a.ok) {
        if (a.status === 401) this.failures.fail(this.remote(req));
        return this.json(res, a.status, { error: a.message });
      }
      if (a.route.kind !== "json-version" && a.route.kind !== "json-list") {
        return this.json(res, 426, {
          error: "this path is for WebSocket connections",
        });
      }
      await this.discovery(a, res);
    } catch (e) {
      this.o.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "request failed",
      );
      if (!res.headersSent)
        this.json(res, 502, { error: "the browser did not answer" });
      else res.destroy();
    }
  }

  /** GET one of Chrome's discovery endpoints from the container, with addresses rewritten to the public one (C2). */
  private async discovery(
    a: Extract<Auth, { ok: true }>,
    res: ServerResponse,
  ): Promise<void> {
    const upstreamPath =
      a.route.kind === "json-version" ? "/json/version" : "/json/list";
    const data = await this.upstreamJson(a.entry, upstreamPath);
    const base = cdpBaseUrl(
      this.o.publicSecure ?? true,
      this.o.publicHostname,
      this.o.publicPort,
      a.route.sessionId,
    );
    const tok = `?${TOKEN_QUERY_PARAM}=${encodeURIComponent(a.token)}`;
    const rewrite = (ws: unknown): string | undefined => {
      if (typeof ws !== "string") return undefined;
      const m = /\/devtools\/(browser|page)\/([A-Za-z0-9-]{1,128})$/.exec(ws);
      return m ? `${base}/devtools/${m[1]}/${m[2]}${tok}` : undefined;
    };
    let out: unknown;
    if (a.route.kind === "json-version") {
      const v = { ...(data as Record<string, unknown>) };
      const url = rewrite(v.webSocketDebuggerUrl);
      if (url) v.webSocketDebuggerUrl = url;
      else delete v.webSocketDebuggerUrl;
      out = v;
    } else {
      out = (Array.isArray(data) ? data : []).map(
        (t: Record<string, unknown>) => {
          const { devtoolsFrontendUrl: _drop, ...rest } = t;
          void _drop;
          const url = rewrite(t.webSocketDebuggerUrl);
          return url ? { ...rest, webSocketDebuggerUrl: url } : rest;
        },
      );
    }
    this.json(res, 200, out);
  }

  private upstreamJson(entry: RouteEntry, path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          host: entry.address,
          port: entry.port,
          path,
          method: "GET",
          headers: { [PROOF_HEADER]: entry.proof },
          timeout: this.o.upstreamTimeoutMs ?? 5_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) {
              r.destroy(new Error("discovery response too large")); // the container is untrusted input
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                throw new Error(`status ${res.statusCode}`);
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("timed out")));
      r.on("error", reject);
      r.end();
    });
  }

  /** Chrome's browser websocket path carries a random id; learn it once per container. */
  private async browserPath(entry: RouteEntry): Promise<string> {
    if (entry.browserPath) return entry.browserPath;
    const v = (await this.upstreamJson(entry, "/json/version")) as {
      webSocketDebuggerUrl?: unknown;
    };
    const m =
      typeof v.webSocketDebuggerUrl === "string"
        ? /(\/devtools\/browser\/[A-Za-z0-9-]{1,128})$/.exec(
            v.webSocketDebuggerUrl,
          )
        : null;
    if (!m?.[1]) throw new Error("the browser reported no websocket address");
    entry.browserPath = m[1];
    return m[1];
  }

  // --- websocket upgrades -------------------------------------------------------------------

  /** Finish the upgrade just to tell the client why it is being refused: a close code reaches a client, an HTTP status often does not. */
  private refuse(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.o.metrics.closes.inc({ code: String(code) });
      ws.close(code, reason);
    });
  }

  private async onUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => undefined);
    const ip = this.remote(req);
    if (this.draining) return this.reply(socket, 503, "draining");
    if (this.failures.blocked(ip))
      return this.reply(socket, 429, "too many failed attempts");
    if (this.pendingHandshakes >= (this.o.maxPendingHandshakes ?? 256))
      return this.reply(socket, 503, "busy");

    this.pendingHandshakes++;
    try {
      const a = await this.authenticate(req);
      if (!a.ok) {
        this.o.metrics.connections.inc({
          result:
            a.close === CLOSE_CODES.tokenInvalid ? "unauthorized" : "refused",
        });
        if (a.status === 404) return this.reply(socket, 404, "not found");
        if (a.status === 401) this.failures.fail(ip);
        return this.refuse(req, socket, head, a.close, a.message);
      }
      const k = a.route.kind;
      if (k === "json-version" || k === "json-list")
        return this.reply(socket, 400, "not a websocket path");

      const set = this.relays.get(a.route.sessionId) ?? new Set<Relay>();
      if (set.size >= this.limits.maxConnectionsPerSession) {
        this.o.metrics.connections.inc({ result: "limit" });
        return this.refuse(
          req,
          socket,
          head,
          CLOSE_CODES.limitExceeded,
          "too many connections to this session",
        );
      }

      let upstream: WebSocket;
      try {
        upstream = await this.openUpstream(a.entry, a.route, a.scope).catch(
          (e: unknown) => {
            // Addresses are reused (a microVM's soon after the last one's at it): a kept-alive
            // connection to the browser that had this address is reset on first use. Nothing has
            // been relayed yet, so trying once more is safe.
            if (!/ECONNRESET|EPIPE|socket hang up/.test(String(e))) throw e;
            return this.openUpstream(a.entry, a.route, a.scope);
          },
        );
      } catch (e) {
        this.o.log.warn(
          {
            session: a.route.sessionId,
            err: e instanceof Error ? e.message : String(e),
          },
          "could not reach the browser",
        );
        this.o.metrics.connections.inc({ result: "upstream_failed" });
        return this.refuse(
          req,
          socket,
          head,
          CLOSE_CODES.sessionEnded,
          "the browser is not reachable",
        );
      }
      this.wss.handleUpgrade(req, socket, head, (client) =>
        this.attach(a.route.sessionId, client, upstream, a.scope === "view"),
      );
    } finally {
      this.pendingHandshakes--;
    }
  }

  private reply(socket: Duplex, status: number, message: string): void {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
    );
  }

  private async openUpstream(
    entry: RouteEntry,
    route: GatewayRoute,
    scope: "cdp" | "view" | "control" = "cdp",
  ): Promise<WebSocket> {
    let path: string;
    const headers: Record<string, string> = { [PROOF_HEADER]: entry.proof };
    if (route.kind === "live") {
      // W2: runtimed's live module; the mode comes from the verified token, never from the client.
      path = RUNTIME_LIVE_PATH;
      headers[LIVE_MODE_HEADER] = scope === "control" ? "control" : "view";
    } else if (
      route.kind === "browser-socket" ||
      route.kind === "browser-socket-id"
    )
      path = await this.browserPath(entry);
    else if (route.kind === "page-socket")
      path = `/devtools/page/${route.targetId}`;
    else throw new Error("not a websocket route");
    return new Promise<WebSocket>((resolve, reject) => {
      const up = new WebSocket(`ws://${entry.address}:${entry.port}${path}`, {
        headers,
        perMessageDeflate: false,
        maxPayload: this.limits.maxMessageBytes,
        handshakeTimeout: this.o.upstreamTimeoutMs ?? 5_000,
      });
      up.once("open", () => resolve(up));
      up.once("error", (e) => {
        // A stale learned path (it cannot change within a container's life, but be safe).
        if (
          route.kind === "browser-socket" ||
          route.kind === "browser-socket-id"
        )
          delete entry.browserPath;
        reject(e);
      });
    });
  }

  private attach(
    sessionId: string,
    client: WebSocket,
    upstream: WebSocket,
    passive = false,
  ): void {
    const set = this.relays.get(sessionId) ?? new Set<Relay>();
    this.relays.set(sessionId, set);
    const relay = new Relay(client, upstream, {
      limits: this.limits,
      sessionId,
      budget: this.budget,
      admit: (n) => this.admit(sessionId, n),
      onBytes: (dir, n) => this.o.metrics.bytes.inc({ direction: dir }, n),
      onPause: (reason) => this.o.metrics.pauses.inc({ reason }),
      onClosed: (code) => {
        set.delete(relay);
        if (set.size === 0) this.relays.delete(sessionId);
        this.o.metrics.open.set(this.connectionCount());
        this.o.metrics.closes.inc({ code: String(code) });
        this.changed();
      },
    });
    set.add(relay);
    if (passive) this.passive.add(relay);
    this.o.metrics.connections.inc({ result: "ok" });
    this.o.metrics.open.set(this.connectionCount());
    relay.start();
    this.changed();
  }

  private pendingNotify = false;
  private changed(): void {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    queueMicrotask(() => {
      this.pendingNotify = false;
      this.o.onAttachments?.(this.attachments());
    });
  }

  /** A route whose time has passed no longer serves its connections, whether or not the agent has said so. */
  private expireRoutes(): void {
    const now = this.clock.now();
    this.spent.prune(now);
    for (const id of [...this.relays.keys()]) {
      const e = this.o.table.get(id);
      if (!e || e.notAfter * 1000 < now)
        this.closeSession(id, CLOSE_CODES.sessionEnded, "session ended");
    }
  }
}

export { redactToken };
