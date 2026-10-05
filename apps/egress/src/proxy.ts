import { connect as netConnect, type Socket } from "node:net";
import {
  Agent,
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { PROXY_BLOCKED_PORTS, type EgressDenyReason } from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import { ipAllowed, parseHost } from "./addresses.js";
import type { DenialLog } from "./denials.js";
import type { EgressMetrics } from "./metrics.js";
import {
  listDecision,
  type Entry,
  type PolicyStore,
  type UpstreamEntry,
} from "./policy.js";
import type { Resolver } from "./resolver.js";
import { readConnectReply } from "./upstream.js";

/** N9. The gateway must not be a general relay: web ports only. */
const ALLOWED_PORTS = new Set([80, 443]);
/** Methods that carry no body. A body on one of these is how a second request is smuggled behind the first. */
const BODYLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"]);
/** At most this many name resolutions at once across all sessions, so one session cannot saturate DNS for the rest. */
const MAX_RESOLVES = 64;

export interface ProxyOptions {
  policies: PolicyStore;
  resolver: Resolver;
  denials: DenialLog;
  metrics: EgressMetrics;
  log: Logger;
  /** The host's own addresses, which a session must never reach (so it cannot call the platform's public endpoints). */
  blockedAddresses?: Set<string>;
  /** Open a connection to an address already checked. Injectable for tests. */
  connect?: (ip: string, port: number) => Socket;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** A client that has not finished its request this soon is dropped. */
  preRequestTimeoutMs?: number;
  maxConnections?: number;
  /** The whole of an upstream proxy's reply to CONNECT must arrive within this. */
  upstreamReplyTimeoutMs?: number;
}

type Decision =
  | {
      ok: true;
      /**
       * Checked addresses to connect to: the destination's, or with `via` the proxy's. There is
       * no path from an upstream decision to the destination's own address (T-47).
       */
      addresses: string[];
      /** The session's upstream proxy, if it has one. */
      via: UpstreamEntry | undefined;
      host: string;
      port: number;
      /** The policy this decision was made under, compared by identity after every wait. */
      entry: Entry;
      /** Give back the slot reserved against the cap. */
      release: () => void;
    }
  | {
      ok: false;
      reason: EgressDenyReason;
      status: number;
      message: string;
      host: string;
      port: number;
    };

/** `::ffff:1.2.3.4` is the same peer as `1.2.3.4`. */
const normalizePeer = (a: string | undefined): string =>
  (a ?? "").replace(/^::ffff:/, "");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * An agent that can only open one connection, to an address that has already been checked. The
 * request is made with the checked IP, never the name, and this makes it impossible for the HTTP
 * client to resolve or choose anything itself.
 */
class PinnedAgent extends Agent {
  constructor(private readonly open: () => Socket) {
    super({ keepAlive: false });
  }
  override createConnection(): Socket {
    return this.open();
  }
}

/**
 * N5-N14. A forward proxy in Node. It identifies a session by the source address of the
 * connection, applies the session's policy, resolves each hostname once, checks every address it
 * returns, and connects to the address it checked, so a name cannot be re-pointed after the check.
 * It serves CONNECT (HTTPS, and anything Chrome tunnels) and plain HTTP proxy requests.
 *
 * Everything the browser sends is hostile, so every wait is bounded and every slot is accounted:
 * the cap is reserved before any asynchronous work, a refused socket is destroyed, a plain HTTP
 * connection carries one request, and whatever an upstream server answers is validated before it
 * is relayed.
 */
export class EgressProxy {
  private http: Server | undefined;
  private readonly connectFn: (ip: string, port: number) => Socket;
  private resolving = 0;
  private usedSockets = new WeakSet<Socket>();

  constructor(private readonly o: ProxyOptions) {
    this.connectFn =
      o.connect ?? ((ip, port) => netConnect({ host: ip, port }));
  }

  async listen(host: string, port: number): Promise<number> {
    const pre = this.o.preRequestTimeoutMs ?? 15_000;
    this.http = createHttpServer(
      {
        maxHeaderSize: 16 * 1024,
        headersTimeout: pre,
        requestTimeout: 0,
        keepAliveTimeout: 1_000,
        connectionsCheckingInterval: Math.min(2_000, pre),
      },
      (req, res) => void this.onRequest(req, res),
    );
    this.http.maxConnections = this.o.maxConnections ?? 4096;
    // A connection that does nothing is not held forever, whether or not it ever sends a request.
    this.http.on("connection", (s) => s.setTimeout(pre * 4, () => s.destroy()));
    this.http.on(
      "connect",
      (req, socket, head) => void this.onConnect(req, socket as Socket, head),
    );
    this.http.on("clientError", (_e, socket) => {
      // The parser refused it (ambiguous length, bad framing): say so, then drop the connection.
      if (socket.writable) {
        this.endAndDestroy(
          socket as Socket,
          "HTTP/1.1 400 Bad Request\r\nx-kestrel-egress-denied: blocked_address\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(port, host, resolve);
    });
    const a = this.http.address();
    return typeof a === "object" && a ? a.port : port;
  }

  async close(): Promise<void> {
    // CONNECT tunnels are detached from the HTTP server, so cut them through the policies that track them.
    for (const { entry } of this.o.policies.list())
      for (const s of entry.sockets) s.destroy();
    this.http?.closeAllConnections();
    await new Promise<void>((r) =>
      this.http ? this.http.close(() => r()) : r(),
    );
  }

  /** Write a final message and close. A half-open socket would otherwise stay until the peer chose to leave. */
  private endAndDestroy(socket: Socket, message: string): void {
    const t = setTimeout(() => socket.destroy(), 2_000);
    t.unref();
    socket.end(message, () => {
      clearTimeout(t);
      socket.destroy();
    });
  }

  // --- the decision -------------------------------------------------------------------------

  /**
   * Decide whether a request may go through. On success a slot is held against the session's cap
   * and must be released by the caller. The slot is taken before the first wait, so a burst of
   * requests cannot all pass the check while their resolutions are still running.
   */
  private async decide(
    source: string,
    rawHost: string,
    port: number,
  ): Promise<Decision> {
    const deny = (
      reason: EgressDenyReason,
      status: number,
      message: string,
      host = rawHost,
    ): Decision => ({
      ok: false,
      reason,
      status,
      message,
      host,
      port,
    });

    const entry = this.o.policies.get(source);
    if (!entry) return deny("no_policy", 403, "no policy for this address");

    const target = parseHost(rawHost);
    if (target.kind === "invalid")
      return deny("blocked_address", 400, `bad host: ${target.why}`);
    const host = target.kind === "ip" ? target.ip : target.name.toLowerCase();

    if (!ALLOWED_PORTS.has(port))
      return deny(
        "port_not_allowed",
        403,
        "only ports 80 and 443 are allowed",
        host,
      );

    const listed = listDecision(entry, host, target.kind === "ip");
    if (listed)
      return deny(
        listed,
        403,
        listed === "in_deny_list"
          ? "host is in the deny list"
          : "host is not in the allow list",
        host,
      );

    if (entry.active >= entry.connectionCap)
      return deny(
        "connection_cap",
        503,
        "too many simultaneous connections",
        host,
      );
    entry.active++;
    let handedOver = false;
    try {
      let addresses: string[];
      const via = entry.upstream;
      if (via) {
        // Through a proxy the destination is not resolved here: the proxy resolves it from its
        // own network. A literal address must still be public. The proxy's own address is
        // what this process connects to, so it gets the full checks (T-44).
        if (
          target.kind === "ip" &&
          (!ipAllowed(target.ip) || this.o.blockedAddresses?.has(target.ip))
        )
          return deny("blocked_address", 403, "address is not allowed", host);
        if (PROXY_BLOCKED_PORTS.has(via.port))
          return deny(
            "upstream_blocked",
            403,
            "the proxy's port is not allowed",
            host,
          );
        const proxyAddresses = await this.resolveProxy(via);
        if (proxyAddresses === "busy")
          return deny(
            "upstream_unreachable",
            503,
            "the resolver is busy",
            host,
          );
        if (proxyAddresses.length === 0)
          return deny(
            "upstream_unreachable",
            502,
            "the proxy's name did not resolve",
            host,
          );
        for (const a of proxyAddresses)
          if (!ipAllowed(a) || this.o.blockedAddresses?.has(a))
            return deny(
              "upstream_blocked",
              403,
              "the proxy's address is not allowed",
              host,
            );
        addresses = proxyAddresses;
      } else if (target.kind === "ip") {
        addresses = [target.ip];
      } else {
        if (this.resolving >= MAX_RESOLVES)
          return deny("resolve_failed", 503, "the resolver is busy", host);
        this.resolving++;
        try {
          addresses = await this.o.resolver.resolve4(host);
        } finally {
          this.resolving--;
        }
        if (addresses.length === 0)
          return deny(
            "resolve_failed",
            502,
            "the name did not resolve to an IPv4 address",
            host,
          );
      }
      // Every address returned must be acceptable: a name that resolves to both a public and an
      // internal address is refused outright (N8), not "served from the public one".
      for (const a of addresses) {
        if (!ipAllowed(a) || this.o.blockedAddresses?.has(a))
          return deny("blocked_address", 403, "address is not allowed", host);
      }
      // The policy may have been cleared or replaced while we waited: the decision belongs to the old one.
      if (this.o.policies.get(source) !== entry)
        return deny("no_policy", 403, "the policy changed", host);
      handedOver = true;
      let released = false;
      return {
        ok: true,
        addresses,
        via,
        host,
        port,
        entry,
        release: () => {
          if (!released) {
            released = true;
            entry.active = Math.max(0, entry.active - 1);
          }
        },
      };
    } finally {
      if (!handedOver) entry.active = Math.max(0, entry.active - 1);
    }
  }

  /** The proxy's addresses: its literal, or a resolution under the shared limit. */
  private async resolveProxy(via: UpstreamEntry): Promise<string[] | "busy"> {
    if (via.ip) return [via.ip];
    if (this.resolving >= MAX_RESOLVES) return "busy";
    this.resolving++;
    try {
      return await this.o.resolver.resolve4(via.host);
    } finally {
      this.resolving--;
    }
  }

  /** A connection through the proxy failed after the decision: count it and report it. */
  private upstreamFailed(
    source: string,
    d: Extract<Decision, { ok: true }>,
    reason: EgressDenyReason,
    status: number,
    message: string,
  ): Extract<Decision, { ok: false }> {
    const denial = {
      ok: false as const,
      reason,
      status,
      message,
      host: d.host,
      port: d.port,
    };
    this.recordDenial(source, denial);
    return denial;
  }

  private recordDenial(
    source: string,
    d: Extract<Decision, { ok: false }>,
  ): void {
    this.o.metrics.requests.inc({ result: d.reason });
    const sessionId = this.o.policies.get(source)?.sessionId;
    // Only a known session gets an event; a stranger's attempts are counted in metrics, not on anyone's timeline.
    if (sessionId)
      this.o.denials.add({
        sessionId,
        host: d.host.slice(0, 253),
        port: d.port,
        reason: d.reason,
      });
  }

  // --- CONNECT ------------------------------------------------------------------------------

  private async onConnect(
    req: IncomingMessage,
    client: Socket,
    head: Buffer,
  ): Promise<void> {
    client.on("error", () => undefined);
    const source = normalizePeer(client.remoteAddress);
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!m)
      return this.refuse(client, 400, "bad CONNECT target", "blocked_address");
    const port = Number(m[2]);

    let d: Decision;
    try {
      d = await this.decide(source, m[1] as string, port);
    } catch (e) {
      this.o.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "egress decision failed",
      );
      return this.refuse(client, 502, "egress error", "resolve_failed");
    }
    if (!d.ok) {
      this.recordDenial(source, d);
      return this.refuse(client, d.status, d.message, d.reason);
    }
    if (d.via) return this.connectVia(source, client, head, d, d.via);
    this.o.metrics.requests.inc({ result: "allowed" });
    const { entry } = d;

    let upstream: Socket | null = null;
    try {
      upstream = await this.dial(d.addresses, d.port);
    } finally {
      if (!upstream) d.release();
    }
    if (!upstream)
      return this.refuse(client, 502, "could not connect", "resolve_failed");
    if (client.destroyed || this.o.policies.get(source) !== entry) {
      d.release();
      upstream.destroy();
      client.destroy();
      return;
    }
    this.splice(client, upstream, head, Buffer.alloc(0), d);
  }

  /**
   * CONNECT through the session's proxy: connect to a checked address of the proxy, ask it for
   * a tunnel to the destination by name, and read its answer as hostile input. Only a 2xx opens
   * the tunnel, and nothing of the proxy's answer reaches Chrome (T-46). Every failure path
   * gives back the slot and never connects anywhere else (T-47).
   */
  private async connectVia(
    source: string,
    client: Socket,
    head: Buffer,
    d: Extract<Decision, { ok: true }>,
    via: UpstreamEntry,
  ): Promise<void> {
    const fail = (
      reason: EgressDenyReason,
      status: number,
      message: string,
    ): void => {
      d.release();
      this.upstreamFailed(source, d, reason, status, message);
      if (!client.destroyed) this.refuse(client, status, message, reason);
    };

    let proxy: Socket | null = null;
    try {
      proxy = await this.dial(d.addresses, via.port);
    } catch {
      proxy = null;
    }
    if (!proxy)
      return fail(
        "upstream_unreachable",
        502,
        "could not connect to the proxy",
      );
    proxy.on("error", () => undefined);
    // Leaving mid-handshake, or the policy being cleared, ends the handshake at once.
    const abandon = (): void => {
      proxy.destroy();
    };
    client.once("close", abandon);
    d.entry.sockets.add(client);

    const target = `${d.host}:${d.port}`;
    proxy.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        (via.authorization
          ? `Proxy-Authorization: ${via.authorization}\r\n`
          : "") +
        "\r\n",
    );
    const reply = await readConnectReply(
      proxy,
      this.o.upstreamReplyTimeoutMs ?? 10_000,
    );
    client.off("close", abandon);
    d.entry.sockets.delete(client);

    if (client.destroyed || this.o.policies.get(source) !== d.entry) {
      d.release();
      proxy.destroy();
      client.destroy();
      return;
    }
    if (reply.kind !== "ok") {
      proxy.destroy();
      if (reply.kind === "auth")
        return fail(
          "upstream_auth_failed",
          502,
          "the proxy refused the credentials",
        );
      if (reply.kind === "refused")
        return fail(
          "upstream_refused",
          502,
          "the proxy refused the connection",
        );
      if (reply.kind === "timeout")
        return fail(
          "upstream_unreachable",
          504,
          "the proxy did not answer in time",
        );
      return fail(
        "upstream_unreachable",
        502,
        "the proxy closed the connection",
      );
    }
    this.o.metrics.requests.inc({ result: "allowed" });
    this.splice(client, proxy, head, reply.rest, d);
  }

  /** Relay both ways until either side closes, the idle timeout passes or the policy is cleared. */
  private splice(
    client: Socket,
    upstream: Socket,
    head: Buffer,
    early: Buffer,
    d: Extract<Decision, { ok: true }>,
  ): void {
    const { entry } = d;
    entry.sockets.add(client);
    this.o.metrics.open.inc();
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      entry.sockets.delete(client);
      d.release();
      this.o.metrics.open.dec();
      client.destroy();
      upstream.destroy();
    };
    client.on("close", done);
    upstream.on("close", done);
    upstream.on("error", done);
    const idle = this.o.idleTimeoutMs ?? 5 * 60_000;
    client.setTimeout(idle, done);
    upstream.setTimeout(idle, done);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (early.length) client.write(early);
    if (head.length) upstream.write(head);
    client.on("data", (c) =>
      this.o.metrics.bytes.inc({ direction: "out" }, c.length),
    );
    upstream.on("data", (c) =>
      this.o.metrics.bytes.inc({ direction: "in" }, c.length),
    );
    client.pipe(upstream);
    upstream.pipe(client);
    // A socket paused while its reply was read starts flowing again through the pipe.
    upstream.resume();
  }

  /** Connect to the first checked address that answers. */
  private async dial(
    addresses: string[],
    port: number,
  ): Promise<Socket | null> {
    for (const ip of addresses.slice(0, 3)) {
      const s = await new Promise<Socket | null>((resolve) => {
        const sock = this.connectFn(ip, port);
        const timer = setTimeout(() => {
          sock.destroy();
          resolve(null);
        }, this.o.connectTimeoutMs ?? 10_000);
        sock.once("connect", () => {
          clearTimeout(timer);
          resolve(sock);
        });
        sock.once("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      if (s) return s;
    }
    return null;
  }

  private refuse(
    client: Socket,
    status: number,
    message: string,
    reason: EgressDenyReason,
  ): void {
    this.endAndDestroy(
      client,
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Error"}\r\nx-kestrel-egress-denied: ${reason}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`,
    );
  }

  // --- plain HTTP ---------------------------------------------------------------------------

  private deny(
    res: ServerResponse,
    status: number,
    message: string,
    reason: EgressDenyReason,
  ): void {
    res.writeHead(status, {
      "x-kestrel-egress-denied": reason,
      "content-type": "text/plain",
      connection: "close",
    });
    res.end(message, () => res.socket?.destroy());
  }

  private async onRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const source = normalizePeer(req.socket.remoteAddress);
    // One request per connection. A second one pipelined behind it would be a second dial that
    // the cap, which counts requests, would never see.
    if (this.usedSockets.has(req.socket)) {
      // Answer it with a refusal and let the first request finish: destroying the socket here would kill that one too.
      return this.deny(
        res,
        400,
        "one request per connection",
        "blocked_address",
      );
    }
    this.usedSockets.add(req.socket);

    let url: URL;
    try {
      // A proxy request carries an absolute URI. Origin-form ("/path") is a request to the proxy itself.
      if (!/^http:\/\//i.test(req.url ?? ""))
        return this.deny(
          res,
          400,
          "this is a proxy: send an absolute http:// URI or CONNECT",
          "blocked_address",
        );
      url = new URL(req.url as string);
    } catch {
      return this.deny(res, 400, "bad URL", "blocked_address");
    }
    if (url.username || url.password)
      return this.deny(
        res,
        400,
        "credentials in the URL are not allowed",
        "blocked_address",
      );
    // The request line and the Host header must agree: a mismatch is how requests get smuggled past a check.
    const hostHeader = req.headers.host;
    if (hostHeader && hostHeader.toLowerCase() !== url.host.toLowerCase()) {
      return this.deny(
        res,
        400,
        "Host header does not match the request URL",
        "blocked_address",
      );
    }
    if (
      req.headers["content-length"] !== undefined &&
      req.headers["transfer-encoding"] !== undefined
    ) {
      return this.deny(res, 400, "ambiguous message length", "blocked_address");
    }
    // A body on a method that has none would be relayed unframed and read by the destination as the next request.
    const method = (req.method ?? "GET").toUpperCase();
    if (
      BODYLESS.has(method) &&
      (req.headers["transfer-encoding"] !== undefined ||
        Number(req.headers["content-length"] ?? 0) > 0)
    ) {
      return this.deny(
        res,
        400,
        `a ${method} request must not have a body`,
        "blocked_address",
      );
    }
    const port = url.port ? Number(url.port) : 80;

    let d: Decision;
    try {
      d = await this.decide(source, url.hostname, port);
    } catch {
      return this.deny(res, 502, "egress error", "resolve_failed");
    }
    if (!d.ok) {
      this.recordDenial(source, d);
      return this.deny(res, d.status, d.message, d.reason);
    }
    const { entry, via } = d;
    if (!via) this.o.metrics.requests.inc({ result: "allowed" });

    entry.sockets.add(req.socket);
    this.o.metrics.open.inc();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      entry.sockets.delete(req.socket);
      d.release();
      this.o.metrics.open.dec();
    };
    res.on("close", finish);
    res.setTimeout(this.o.idleTimeoutMs ?? 5 * 60_000, () => res.destroy());

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = url.host;
    headers.connection = "close";
    // Through a proxy: the absolute URI, by name, and our credentials. Chrome's own
    // Proxy-Authorization, if any, was stripped above as hop-by-hop.
    if (via?.authorization) headers["proxy-authorization"] = via.authorization;
    const dialPort = via ? via.port : d.port;
    let failed = false;
    const upstreamFailed = (
      reason: EgressDenyReason,
      message: string,
    ): void => {
      if (failed) return;
      failed = true;
      if (via) {
        this.upstreamFailed(source, d, reason, 502, message);
        this.fail(res, message, reason);
      } else {
        this.fail(res, message);
      }
    };

    const upstream = httpRequest(
      {
        host: d.addresses[0],
        port: dialPort,
        method,
        path: via
          ? `http://${url.host}${url.pathname}${url.search}`
          : url.pathname + url.search,
        headers,
        agent: new PinnedAgent(() =>
          this.connectFn(d.addresses[0] as string, dialPort),
        ),
        setHost: false,
        timeout: this.o.connectTimeoutMs ?? 10_000,
      },
      (up) => {
        try {
          // The destination is untrusted: a status outside 200-599 (or an upgrade) is not relayed.
          const code = up.statusCode ?? 0;
          if (code < 200 || code > 599) {
            up.destroy();
            return upstreamFailed(
              "upstream_refused",
              "upstream sent an invalid status",
            );
          }
          if (via && code === 407) {
            up.destroy();
            return upstreamFailed(
              "upstream_auth_failed",
              "the proxy refused the credentials",
            );
          }
          if (via) this.o.metrics.requests.inc({ result: "allowed" });
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(up.headers))
            if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
          out.connection = "close";
          res.writeHead(code, out);
          up.on("aborted", () => res.destroy());
          up.on("error", () => res.destroy());
          up.pipe(res);
        } catch {
          up.destroy();
          this.fail(res, "upstream response could not be relayed");
        }
      },
    );
    // The destination answered 101: we never asked to upgrade, so this is not something to relay.
    upstream.on("upgrade", (_up, socket) => {
      socket.destroy();
      upstreamFailed(
        "upstream_refused",
        "upstream attempted a protocol upgrade",
      );
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (e) => {
      this.o.log.debug({ err: e.message }, "upstream request failed");
      if (failed) return;
      if (res.headersSent || res.writableEnded) return this.fail(res, "");
      upstreamFailed("upstream_unreachable", "upstream error");
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  }

  /** Answer 502 if nothing has been sent yet; otherwise the response is already half out, so drop it. */
  private fail(
    res: ServerResponse,
    message: string,
    reason: EgressDenyReason = "resolve_failed",
  ): void {
    if (!res.headersSent && !res.writableEnded)
      this.deny(res, 502, message, reason);
    else res.destroy();
  }
}
