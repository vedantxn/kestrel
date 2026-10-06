import { readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  connect,
  createServer as createTcpServer,
  isIPv4,
  type Server as TcpServer,
  type Socket,
} from "node:net";

/**
 * A small proxy for the upstream-proxy check (`bench proxy`, docs/lld/upstream-proxy.md): HTTP
 * with Basic authentication, the same over TLS, or SOCKS5 with username and password (RFC 1928,
 * 1929). It runs on the benchmark runner, so a session that uses it exits from the runner's
 * address. It resolves targets itself, as a real proxy does, and logs one JSON line per request
 * with the target as asked for (showing whether the egress gateway sent a hostname) and the
 * username it saw, never the password.
 *
 * Provider adapters change the credentials a proxy receives, so this one accepts a username that
 * contains the configured one (`user-k-country-de...`, `brd-customer-k-zone-x-...`) and a password
 * that is the configured one or starts with it and `_` (IPRoyal's `pw_country-de...`), and tells a
 * page what it saw at `http://proxy-check.kestrel.test/who`.
 *
 * Plain Node with erasable types only, so the runner can run it from source:
 *   PROXY_USER=u PROXY_PASSWORD=... PORT=3129 [MODE=http|https|socks5] [TLS_CERT=f TLS_KEY=f] \
 *     node --experimental-strip-types bench/framework/src/test-proxy.ts
 */
export interface TestProxyOptions {
  user: string;
  password: string;
  /** Destination ports it will tunnel to; the default keeps it from being a general relay. */
  allowPorts?: number[];
  log?: (line: string) => void;
  /** Serve HTTPS: TLS to this proxy, then the same CONNECT and absolute-URI handling. */
  tls?: { key: string; cert: string };
}

/**
 * A name only this proxy knows. It answers plain-HTTP requests for it itself, and refuses
 * CONNECT to it, so a page there loads only through absolute-URI forwarding (or, through SOCKS5,
 * an origin-form request down the tunnel), and only if the egress gateway left the name for the
 * proxy to resolve. (Chrome upgrades ordinary http:// navigations to HTTPS where it can, so a
 * real site does not exercise plain HTTP.)
 *
 *  - `/who`: JSON `{via, username, passwordExtra}`: what the proxy received (`passwordExtra` is
 *    what followed the configured password, the exit request of an adapter like IPRoyal's).
 *  - `/bytes/<n>`: n bytes, for the byte-counter check (at most 64 MiB).
 *  - anything else: one line naming the request.
 */
export const SELF_HOST = "proxy-check.kestrel.test";
const MAX_BYTES = 64 * 1024 * 1024;

interface Seen {
  via: "http" | "https" | "socks5";
  username: string;
  passwordExtra: string;
}

function credsOk(o: TestProxyOptions, u: string, p: string): string | null {
  if (!u.includes(o.user)) return null;
  if (p === o.password) return "";
  if (p.startsWith(`${o.password}_`)) return p.slice(o.password.length);
  return null;
}

/** Answer a plain-HTTP request for SELF_HOST. */
function answerSelf(req: IncomingMessage, res: ServerResponse, seen: Seen) {
  const path = new URL(req.url ?? "/", `http://${SELF_HOST}`).pathname;
  const bytes = /^\/bytes\/(\d{1,9})$/.exec(path);
  if (bytes) {
    const n = Math.min(Number(bytes[1]), MAX_BYTES);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": n,
      "cache-control": "no-store",
    });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let left = n;
    const pump = (): void => {
      while (left > 0) {
        const part = chunk.subarray(0, Math.min(left, chunk.length));
        left -= part.length;
        if (!res.write(part)) return void res.once("drain", pump);
      }
      res.end();
    };
    return pump();
  }
  const body =
    path === "/who"
      ? JSON.stringify(seen)
      : `plain http via the test proxy: ${req.method} ${req.url}`;
  res.writeHead(200, {
    "content-type": path === "/who" ? "application/json" : "text/plain",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createTestProxy(o: TestProxyOptions): Server {
  const allow = new Set(o.allowPorts ?? [80, 443]);
  const log = o.log ?? ((l: string) => console.log(l));
  const via = o.tls ? "https" : "http";
  const authOf = (
    req: IncomingMessage,
  ): { auth: "ok" | "bad" | "none"; seen?: Seen } => {
    const h = req.headers["proxy-authorization"];
    if (!h) return { auth: "none" };
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(h);
    if (!m) return { auth: "bad" };
    const decoded = Buffer.from(m[1] as string, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return { auth: "bad" };
    const username = decoded.slice(0, i);
    const extra = credsOk(o, username, decoded.slice(i + 1));
    return extra === null
      ? { auth: "bad" }
      : { auth: "ok", seen: { via, username, passwordExtra: extra } };
  };
  const record = (
    req: IncomingMessage,
    auth: string,
    result: string,
    seen?: Seen,
  ) =>
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        from: req.socket.remoteAddress,
        via,
        method: req.method,
        target: req.url,
        auth,
        username: seen?.username,
        result,
      }),
    );

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const { auth, seen } = authOf(req);
    if (auth !== "ok" || !seen) {
      record(req, auth, "407");
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
      return void res.end();
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      record(req, auth, "400", seen);
      res.writeHead(400);
      return void res.end();
    }
    const port = Number(url.port || 80);
    if (url.hostname === SELF_HOST) {
      record(req, auth, "200", seen);
      return answerSelf(req, res, seen);
    }
    if (url.protocol !== "http:" || !allow.has(port)) {
      record(req, auth, "403", seen);
      res.writeHead(403);
      return void res.end();
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const up = httpRequest(
      {
        host: url.hostname,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (r) => {
        record(req, auth, String(r.statusCode), seen);
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      record(req, auth, "502", seen);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  };

  const server: Server = o.tls
    ? (createHttpsServer(o.tls, onRequest) as unknown as Server)
    : createServer(onRequest);
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const { auth, seen } = authOf(req);
    if (auth !== "ok") {
      record(req, auth, "407");
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const m = /^([^:]+):(\d+)$/.exec(req.url ?? "");
    if (!m || !allow.has(Number(m[2])) || m[1] === SELF_HOST) {
      record(req, auth, "403", seen);
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = connect({ host: m[1] as string, port: Number(m[2]) });
    up.on("connect", () => {
      record(req, auth, "200", seen);
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => {
      record(req, auth, "502", seen);
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    client.on("close", () => up.destroy());
  });
  return server;
}

/**
 * A SOCKS5 proxy with username and password authentication (RFC 1928, 1929). A CONNECT to
 * SELF_HOST:80 is answered by its own HTTP handler, as the HTTP proxy answers that name.
 */
export function createTestSocksProxy(o: TestProxyOptions): TcpServer {
  const allow = new Set(o.allowPorts ?? [80, 443]);
  const log = o.log ?? ((l: string) => console.log(l));
  const seenBy = new WeakMap<Socket, Seen>();
  const self = createServer((req, res) =>
    answerSelf(
      req,
      res,
      seenBy.get(req.socket) ?? {
        via: "socks5",
        username: "",
        passwordExtra: "",
      },
    ),
  );
  const record = (
    s: Socket,
    target: string,
    auth: string,
    result: string,
    username?: string,
  ) =>
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        from: s.remoteAddress,
        via: "socks5",
        target,
        auth,
        username,
        result,
      }),
    );

  return createTcpServer((s) => {
    s.on("error", () => undefined);
    s.setTimeout(30_000, () => s.destroy());
    let buf = Buffer.alloc(0);
    let step: "greet" | "auth" | "request" = "greet";
    let seen: Seen | undefined;
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > 1024) return void s.destroy();
      if (step === "greet") {
        if (buf.length < 2 || buf.length < 2 + (buf[1] as number)) return;
        const methods = [...buf.subarray(2, 2 + (buf[1] as number))];
        buf = buf.subarray(2 + (buf[1] as number));
        if (!methods.includes(2)) {
          record(s, "", "none", "auth required");
          return void s.end(Buffer.from([5, 0xff]));
        }
        s.write(Buffer.from([5, 2]));
        step = "auth";
      }
      if (step === "auth") {
        if (buf.length < 2) return;
        const ul = buf[1] as number;
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul] as number;
        if (buf.length < 3 + ul + pl) return;
        const username = buf.subarray(2, 2 + ul).toString("utf8");
        const password = buf.subarray(3 + ul, 3 + ul + pl).toString("utf8");
        buf = buf.subarray(3 + ul + pl);
        const extra = credsOk(o, username, password);
        if (extra === null) {
          record(s, "", "bad", "auth failed", username);
          return void s.end(Buffer.from([1, 1]));
        }
        seen = { via: "socks5", username, passwordExtra: extra };
        s.write(Buffer.from([1, 0]));
        step = "request";
      }
      if (step === "request") {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host: string;
        let len: number;
        if (atyp === 1) {
          len = 4;
          if (buf.length < 4 + len + 2) return;
          host = [...buf.subarray(4, 8)].join(".");
        } else if (atyp === 3) {
          len = 1 + (buf[4] as number);
          if (buf.length < 4 + len + 2) return;
          host = buf.subarray(5, 4 + len).toString("ascii");
        } else {
          return void s.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
        const port = buf.readUInt16BE(4 + len);
        const rest = buf.subarray(4 + len + 2);
        s.off("data", onData);
        s.setTimeout(0);
        const target = `${atyp === 3 ? "name" : "ip"}:${host}:${port}`;
        const ok = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        if (host === SELF_HOST && port === 80) {
          record(s, target, "ok", "200", seen?.username);
          s.write(ok);
          if (seen) seenBy.set(s, seen);
          if (rest.length) s.unshift(rest);
          self.emit("connection", s);
          return;
        }
        if (buf[1] !== 1 || !allow.has(port) || (atyp === 1 && !isIPv4(host))) {
          record(s, target, "ok", "refused", seen?.username);
          return void s.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
        const up = connect({ host, port });
        up.on("connect", () => {
          record(s, target, "ok", "200", seen?.username);
          s.write(ok);
          if (rest.length) up.write(rest);
          up.pipe(s);
          s.pipe(up);
        });
        up.on("error", () => {
          record(s, target, "ok", "unreachable", seen?.username);
          s.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
        s.on("close", () => up.destroy());
      }
    };
    s.on("data", onData);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const user = process.env.PROXY_USER;
  const password = process.env.PROXY_PASSWORD;
  if (!user || !password) {
    console.error("PROXY_USER and PROXY_PASSWORD are required");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? 3129);
  const mode = process.env.MODE ?? "http";
  const opts: TestProxyOptions = { user, password };
  if (mode === "https") {
    const cert = process.env.TLS_CERT;
    const key = process.env.TLS_KEY;
    if (!cert || !key) {
      console.error("MODE=https needs TLS_CERT and TLS_KEY (PEM files)");
      process.exit(2);
    }
    opts.tls = {
      cert: readFileSync(cert, "utf8"),
      key: readFileSync(key, "utf8"),
    };
  }
  const server =
    mode === "socks5" ? createTestSocksProxy(opts) : createTestProxy(opts);
  server.listen(port, () =>
    console.error(`test proxy (${mode}) listening on ${port}`),
  );
}
