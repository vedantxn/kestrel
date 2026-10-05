import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, type Socket } from "node:net";

/**
 * A small HTTP proxy with Basic authentication, for the upstream-proxy check (`bench proxy`,
 * docs/lld/upstream-proxy.md). It runs on the benchmark runner, so a session that uses it
 * exits from the runner's address. It resolves CONNECT targets itself, as a real proxy does,
 * and logs one JSON line per request with the target as asked for (showing whether the egress
 * gateway sent a hostname), never the credentials.
 *
 * Plain Node with erasable types only, so the runner can run it from source:
 *   PROXY_USER=u PROXY_PASSWORD=... PORT=3129 node --experimental-strip-types bench/framework/src/test-proxy.ts
 */
export interface TestProxyOptions {
  user: string;
  password: string;
  /** Destination ports it will tunnel to; the default keeps it from being a general relay. */
  allowPorts?: number[];
  log?: (line: string) => void;
}

/**
 * A name only this proxy knows. It answers plain-HTTP requests for it itself, and refuses
 * CONNECT to it, so a page there loads only through absolute-URI forwarding, and only if the
 * egress gateway left the name for the proxy to resolve. (Chrome upgrades ordinary http://
 * navigations to HTTPS where it can, so a real site does not exercise plain HTTP.)
 */
export const SELF_HOST = "proxy-check.kestrel.test";

export function createTestProxy(o: TestProxyOptions): Server {
  const expected =
    "Basic " + Buffer.from(`${o.user}:${o.password}`).toString("base64");
  const allow = new Set(o.allowPorts ?? [80, 443]);
  const log = o.log ?? ((l: string) => console.log(l));
  const authOf = (req: IncomingMessage): "ok" | "bad" | "none" => {
    const h = req.headers["proxy-authorization"];
    if (!h) return "none";
    return h === expected ? "ok" : "bad";
  };
  const record = (req: IncomingMessage, auth: string, result: string) =>
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        from: req.socket.remoteAddress,
        method: req.method,
        target: req.url,
        auth,
        result,
      }),
    );

  const server = createServer((req, res) => {
    const auth = authOf(req);
    if (auth !== "ok") {
      record(req, auth, "407");
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
      return res.end();
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      record(req, auth, "400");
      res.writeHead(400);
      return res.end();
    }
    const port = Number(url.port || 80);
    if (url.hostname === SELF_HOST) {
      record(req, auth, "200");
      const body = `plain http via the test proxy: ${req.method} ${req.url}`;
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
      });
      return res.end(body);
    }
    if (url.protocol !== "http:" || !allow.has(port)) {
      record(req, auth, "403");
      res.writeHead(403);
      return res.end();
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
        record(req, auth, String(r.statusCode));
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => {
      record(req, auth, "502");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const auth = authOf(req);
    if (auth !== "ok") {
      record(req, auth, "407");
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const m = /^([^:]+):(\d+)$/.exec(req.url ?? "");
    if (!m || !allow.has(Number(m[2])) || m[1] === SELF_HOST) {
      record(req, auth, "403");
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = connect({ host: m[1] as string, port: Number(m[2]) });
    up.on("connect", () => {
      record(req, auth, "200");
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => {
      record(req, auth, "502");
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    client.on("close", () => up.destroy());
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const user = process.env.PROXY_USER;
  const password = process.env.PROXY_PASSWORD;
  if (!user || !password) {
    console.error("PROXY_USER and PROXY_PASSWORD are required");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? 3129);
  createTestProxy({ user, password }).listen(port, () =>
    console.error(`test proxy listening on ${port}`),
  );
}
