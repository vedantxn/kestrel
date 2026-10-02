import { connect as netConnect, type Socket } from "node:net";
import {
  Agent,
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { EgressDenyReason } from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import { ipAllowed, parseHost } from "./addresses.js";
import type { DenialLog } from "./denials.js";
import type { EgressMetrics } from "./metrics.js";
import { listDecision, type PolicyStore } from "./policy.js";
import type { Resolver } from "./resolver.js";

/** N9. The gateway must not be a general relay: web ports only. */
const ALLOWED_PORTS = new Set([80, 443]);

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
}

type Decision =
  | { ok: true; addresses: string[]; host: string; port: number }
  | {
      ok: false;
      reason: EgressDenyReason;
      status: number;
      message: string;
      host: string;
      port: number;
    };

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
 * N5-N14. A forward proxy in Node. It identifies a session by the source address of the
 * connection, applies the session's policy, resolves each hostname once, checks every address it
 * returns, and connects to the address it checked, so a name cannot be re-pointed after the check.
 * It serves CONNECT (HTTPS, and anything Chrome tunnels) and plain HTTP proxy requests.
 */
export class EgressProxy {
  private http: Server | undefined;
  private readonly connectFn: (ip: string, port: number) => Socket;

  constructor(private readonly o: ProxyOptions) {
    this.connectFn =
      o.connect ?? ((ip, port) => netConnect({ host: ip, port }));
  }

  async listen(host: string, port: number): Promise<number> {
    this.http = createHttpServer(
      {
        maxHeaderSize: 16 * 1024,
        headersTimeout: 15_000,
        requestTimeout: 0,
        keepAliveTimeout: 1_000,
      },
      (req, res) => void this.onRequest(req, res),
    );
    this.http.on(
      "connect",
      (req, socket, head) => void this.onConnect(req, socket as Socket, head),
    );
    this.http.on("clientError", (_e, socket) => {
      // The parser refused it (ambiguous length, bad framing): say so, then drop the connection.
      if (socket.writable)
        socket.end(
          "HTTP/1.1 400 Bad Request\r\nx-kestrel-egress-denied: blocked_address\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
      else socket.destroy();
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
      for (const s of entry.open) s.destroy();
    this.http?.closeAllConnections();
    await new Promise<void>((r) =>
      this.http ? this.http.close(() => r()) : r(),
    );
  }

  // --- the decision -------------------------------------------------------------------------

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

    if (entry.open.size >= entry.connectionCap)
      return deny(
        "connection_cap",
        503,
        "too many simultaneous connections",
        host,
      );

    let addresses: string[];
    if (target.kind === "ip") {
      addresses = [target.ip];
    } else {
      addresses = await this.o.resolver.resolve4(host);
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
    return { ok: true, addresses, host, port };
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

    const entry = this.o.policies.get(source);
    if (!entry)
      return this.refuse(client, 403, "policy was cleared", "no_policy");
    this.o.metrics.requests.inc({ result: "allowed" });

    const upstream = await this.dial(d.addresses, d.port);
    if (!upstream)
      return this.refuse(client, 502, "could not connect", "resolve_failed");
    if (client.destroyed || !this.o.policies.get(source)) {
      upstream.destroy();
      client.destroy();
      return;
    }

    entry.open.add(client);
    this.o.metrics.open.inc();
    const done = (): void => {
      if (entry.open.delete(client)) this.o.metrics.open.dec();
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
    if (head.length) upstream.write(head);
    client.on("data", (c) =>
      this.o.metrics.bytes.inc({ direction: "out" }, c.length),
    );
    upstream.on("data", (c) =>
      this.o.metrics.bytes.inc({ direction: "in" }, c.length),
    );
    client.pipe(upstream);
    upstream.pipe(client);
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
    client.end(
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
    res.end(message);
  }

  private async onRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const source = normalizePeer(req.socket.remoteAddress);
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
    const entry = this.o.policies.get(source);
    if (!entry) return this.deny(res, 403, "policy was cleared", "no_policy");
    this.o.metrics.requests.inc({ result: "allowed" });

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = url.host;
    headers.connection = "close";

    const upstream = httpRequest(
      {
        host: d.addresses[0],
        port: d.port,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        agent: new PinnedAgent(() =>
          this.connectFn(d.addresses[0] as string, d.port),
        ),
        setHost: false,
        timeout: this.o.connectTimeoutMs ?? 10_000,
        createConnection: () =>
          this.connectFn(d.addresses[0] as string, d.port),
      },
      (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers))
          if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
        out.connection = "close";
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    entry.open.add(req.socket);
    this.o.metrics.open.inc();
    const release = (): void => {
      if (entry.open.delete(req.socket)) this.o.metrics.open.dec();
    };
    res.on("close", release);
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (e) => {
      this.o.log.debug({ err: e.message }, "upstream request failed");
      if (!res.headersSent)
        this.deny(res, 502, "upstream error", "resolve_failed");
      else res.destroy();
    });
    req.pipe(upstream);
  }
}
