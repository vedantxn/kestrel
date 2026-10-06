import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import {
  connect,
  createServer as createTcp,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTls, type TLSSocket } from "node:tls";
import { newId, type EgressPolicy } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";
import { EgressProxy } from "./proxy.js";
import type { Resolver } from "./resolver.js";
import { MAX_SOCKS_REPLY_BYTES } from "./socks5.js";

/*
 * SOCKS5 and TLS-to-the-proxy chaining (docs/lld/upstream-proxy.md), and byte counters per
 * session (threat model G-20). The proxies here are scripted fakes on loopback; the gateway is
 * told they live at a public address, so its own address checks pass.
 */

const SESSION = newId("ses");
const PROXY_IP = "93.184.216.40";
const PASSWORD = "s0cks-pa55";

class StubResolver implements Resolver {
  answers = new Map<string, string[]>([["proxy.test", [PROXY_IP]]]);
  calls: string[] = [];
  async resolve4(name: string) {
    this.calls.push(name);
    return this.answers.get(name) ?? [];
  }
}

// --- certificates, made for this run -------------------------------------------------------

let certs: {
  ca: string;
  key: string;
  cert: string;
  wrongName: string;
  wrongKey: string;
};
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "egress-tls-"));
  const ssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "2",
    "-subj",
    "/CN=kestrel test ca",
  );
  const leaf = (name: string, san: string) => {
    ssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    );
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
    ssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
    );
  };
  leaf("proxy", `DNS:proxy.test,IP:${PROXY_IP}`);
  leaf("other", "DNS:other.test");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  certs = {
    ca: read("ca.crt"),
    key: read("proxy.key"),
    cert: read("proxy.crt"),
    wrongName: read("other.crt"),
    wrongKey: read("other.key"),
  };
});

// --- fake proxies ----------------------------------------------------------------------------

interface SocksSeen {
  methods: number[];
  auth: { user: string; pass: string } | null;
  atyp: number;
  host: string;
  port: number;
}

type SocksMode =
  | "ok"
  | "bad-auth"
  | "no-method"
  | "refuse-5"
  | "garbage"
  | "silent"
  | "endless";

/** A SOCKS5 server (RFC 1928, 1929) that tunnels to an echo, or misbehaves as told. */
function socksServer(
  mode: () => SocksMode,
  seen: SocksSeen[],
  user = "u",
  pass = PASSWORD,
  /** What to do once the tunnel is open; default: echo. */
  onTunnel: (s: Socket, req: SocksSeen) => void = (s) => s.pipe(s),
) {
  return createTcp((s) => {
    s.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let step = 0;
    const rec: SocksSeen = {
      methods: [],
      auth: null,
      atyp: 0,
      host: "",
      port: 0,
    };
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const m = mode();
      for (;;) {
        if (step === 0) {
          if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
          rec.methods = [...buf.subarray(2, 2 + buf[1]!)];
          buf = buf.subarray(2 + buf[1]!);
          if (m === "silent") return;
          if (m === "garbage") return void s.write("HTTP/1.1 400 Bad\r\n\r\n");
          if (m === "endless") {
            const junk = Buffer.alloc(64 * 1024, 0x05);
            s.write(junk);
            return;
          }
          if (m === "no-method") return void s.write(Buffer.from([5, 0xff]));
          const wantAuth = rec.methods.includes(2);
          s.write(Buffer.from([5, wantAuth ? 2 : 0]));
          step = wantAuth ? 1 : 2;
        } else if (step === 1) {
          if (buf.length < 2) return;
          const ul = buf[1]!;
          if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul]!;
          if (buf.length < 3 + ul + pl) return;
          rec.auth = {
            user: buf.subarray(2, 2 + ul).toString(),
            pass: buf.subarray(3 + ul, 3 + ul + pl).toString(),
          };
          buf = buf.subarray(3 + ul + pl);
          const good =
            m !== "bad-auth" &&
            rec.auth.user === user &&
            rec.auth.pass === pass;
          s.write(Buffer.from([1, good ? 0 : 1]));
          if (!good) return void s.end();
          step = 2;
        } else if (step === 2) {
          if (buf.length < 5) return;
          rec.atyp = buf[3]!;
          let len: number;
          let host: string;
          if (rec.atyp === 1) {
            len = 4;
            host = [...buf.subarray(4, 8)].join(".");
          } else {
            len = 1 + buf[4]!;
            host = buf.subarray(5, 4 + len).toString();
          }
          if (buf.length < 4 + len + 2) return;
          rec.host = host;
          rec.port = buf.readUInt16BE(4 + len);
          buf = buf.subarray(4 + len + 2);
          seen.push(rec);
          if (m === "refuse-5")
            return void s.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          s.write(Buffer.from([5, 0, 0, 1, 10, 0, 0, 1, 0x1f, 0x90]));
          s.off("data", onData);
          if (buf.length) s.unshift(buf);
          onTunnel(s, rec);
          return;
        }
      }
    };
    s.on("data", onData);
  });
}

/** An HTTPS proxy: TLS, then the same CONNECT and absolute-URI handling as an HTTP proxy. */
function tlsProxy(
  key: string,
  cert: string,
  heads: string[],
  sni: (string | false)[],
) {
  return createTls({ key, cert }, (s: TLSSocket) => {
    s.on("error", () => undefined);
    sni.push(s.servername ?? false);
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      heads.push(head);
      if (head.startsWith("CONNECT ")) {
        s.write("HTTP/1.1 200 Connection established\r\n\r\n");
        s.pipe(s);
        return;
      }
      const body = `via tls proxy: ${head.split("\r\n")[0]}`;
      s.end(
        `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      );
    };
    s.on("data", onData);
  });
}

// --- the rig ---------------------------------------------------------------------------------

interface Rig {
  port: number;
  policies: PolicyStore;
  resolver: StubResolver;
  denials: DenialLog;
  dialed: { ip: string; port: number }[];
  close(): Promise<void>;
}
let rig: Rig;
const servers: { close(cb: () => void): unknown }[] = [];
afterEach(async () => {
  await rig?.close();
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

async function listen(s: NetServer): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

async function makeRig(
  upstream: NonNullable<EgressPolicy["upstream"]> | undefined,
  proxyPort: number,
  opts: { ca?: string[] } = {},
): Promise<Rig> {
  const policies = new PolicyStore();
  policies.set("127.0.0.1", {
    sessionId: SESSION as never,
    connectionCap: 256,
    ...(upstream ? { upstream } : {}),
  });
  const resolver = new StubResolver();
  resolver.answers.set("public.test", ["93.184.216.34"]);
  const denials = new DenialLog();
  const dialed: Rig["dialed"] = [];
  // A destination: reached only by a session with no proxy.
  const origin = createHttp((req, res) => {
    let n = 0;
    req.on("data", (c: Buffer) => (n += c.length));
    req.on("end", () => res.end(`direct, ${n} bytes received`));
  });
  const originPort = await listen(origin);
  const proxy = new EgressProxy({
    policies,
    resolver,
    denials,
    metrics: createEgressMetrics(),
    log: createLogger("t", "silent"),
    connectTimeoutMs: 2000,
    idleTimeoutMs: 60_000,
    upstreamReplyTimeoutMs: 500,
    upstreamCa: opts.ca ?? [certs.ca],
    connect: (ip, port) => {
      dialed.push({ ip, port });
      return connect({
        host: "127.0.0.1",
        port: ip === PROXY_IP ? proxyPort : originPort,
      });
    },
  });
  const port = await proxy.listen("127.0.0.1", 0);
  return {
    port,
    policies,
    resolver,
    denials,
    dialed,
    close: async () => {
      origin.closeAllConnections();
      await proxy.close();
    },
  };
}

interface Answer {
  status: number;
  reason: string | undefined;
  socket: Socket;
  rest: Buffer;
}

function send(raw: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port: rig.port });
    let buf = Buffer.alloc(0);
    s.on("error", reject);
    s.on("data", function onData(d: Buffer) {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]),
        reason: /x-kestrel-egress-denied: (\S+)/i.exec(head)?.[1],
        socket: s,
        rest: buf.subarray(end + 4),
      });
    });
    s.write(raw);
  });
}
const tunnel = (target: string) =>
  send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
const readAll = (a: Answer): Promise<string> =>
  new Promise((resolve) => {
    let body = a.rest.toString("latin1");
    a.socket.on("data", (d) => (body += d.toString("latin1")));
    a.socket.on("close", () => resolve(body));
  });
const echo = (a: Answer, payload: Buffer): Promise<Buffer> =>
  new Promise((resolve) => {
    let got = Buffer.from(a.rest);
    const onData = (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= payload.length) {
        a.socket.off("data", onData);
        resolve(got);
      }
    };
    a.socket.on("data", onData);
    a.socket.write(payload);
  });
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const entry = () => rig.policies.get("127.0.0.1")!;
const onlyTheProxyWasDialed = () => {
  expect(rig.dialed.every((d) => d.ip === PROXY_IP)).toBe(true);
  expect(rig.resolver.calls).not.toContain("public.test");
};
const reasons = () => rig.denials.read(0).map((d) => d.reason);

const socks = (
  extra: Partial<NonNullable<EgressPolicy["upstream"]>> = {},
): NonNullable<EgressPolicy["upstream"]> => ({
  scheme: "socks5",
  host: "proxy.test",
  port: 1080,
  username: "u",
  password: PASSWORD,
  ...extra,
});

// --- SOCKS5 ----------------------------------------------------------------------------------

describe("SOCKS5 upstream (RFC 1928, 1929)", () => {
  it("asks for the destination by name, authenticates, relays both ways and counts the bytes", async () => {
    const seen: SocksSeen[] = [];
    const p = await listen(socksServer(() => "ok", seen));
    rig = await makeRig(socks(), p);
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(seen).toEqual([
      {
        methods: [0, 2],
        auth: { user: "u", pass: PASSWORD },
        atyp: 3,
        host: "public.test",
        port: 443,
      },
    ]);
    onlyTheProxyWasDialed();
    const payload = Buffer.alloc(100_000, 7);
    expect((await echo(t, payload)).length).toBe(payload.length);
    expect(entry().bytes.up).toBe(payload.length);
    await waitFor(() => entry().bytes.down === payload.length);
    t.socket.destroy();
    await waitFor(() => entry().active === 0);
  });

  it("sends an IPv4 literal as address type 1, and offers no authentication without credentials", async () => {
    const seen: SocksSeen[] = [];
    const p = await listen(socksServer(() => "ok", seen));
    rig = await makeRig(
      { scheme: "socks5", host: "proxy.test", port: 1080 },
      p,
    );
    const t = await tunnel("93.184.216.34:443");
    expect(t.status).toBe(200);
    expect(seen[0]).toMatchObject({
      methods: [0],
      auth: null,
      atyp: 1,
      host: "93.184.216.34",
      port: 443,
    });
    t.socket.destroy();
  });

  it.each([
    ["bad-auth", 502, "upstream_auth_failed"],
    ["no-method", 502, "upstream_auth_failed"],
    ["refuse-5", 502, "upstream_refused"],
    ["garbage", 502, "upstream_refused"],
    ["endless", 502, "upstream_refused"],
    ["silent", 504, "upstream_unreachable"],
  ] as const)(
    "a proxy that answers %s is refused (%d %s) and nothing goes direct",
    async (mode, status, reason) => {
      const p = await listen(socksServer(() => mode, []));
      rig = await makeRig(socks(), p);
      const t = await tunnel("public.test:443");
      expect(t.status).toBe(status);
      expect(t.reason).toBe(reason);
      onlyTheProxyWasDialed();
      expect(reasons()).toEqual([reason]);
      await waitFor(() => entry().active === 0);
    },
  );

  it("never reads more than a SOCKS5 reply can hold", () => {
    expect(MAX_SOCKS_REPLY_BYTES).toBe(262);
  });

  it("plain HTTP goes down a SOCKS5 tunnel to the destination, in origin form", async () => {
    const seen: SocksSeen[] = [];
    const heads: string[] = [];
    const p = await listen(
      socksServer(
        () => "ok",
        seen,
        "u",
        PASSWORD,
        (s) => {
          let buf = "";
          s.on("data", (d) => {
            buf += d.toString("latin1");
            const end = buf.indexOf("\r\n\r\n");
            if (end < 0) return;
            heads.push(buf.slice(0, end));
            const body = "hello from the far end";
            s.end(
              `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
            );
          });
        },
      ),
    );
    rig = await makeRig(socks(), p);
    const a = await send(
      "GET http://public.test/page?q=1 HTTP/1.1\r\nHost: public.test\r\nProxy-Authorization: Basic Y2hyb21lOng=\r\n\r\n",
    );
    expect(a.status).toBe(200);
    expect(await readAll(a)).toBe("hello from the far end");
    expect(seen[0]).toMatchObject({ atyp: 3, host: "public.test", port: 80 });
    const lines = heads[0]!.split("\r\n");
    expect(lines[0]).toBe("GET /page?q=1 HTTP/1.1");
    expect(lines.some((l) => /^proxy-authorization/i.test(l))).toBe(false);
    onlyTheProxyWasDialed();
    // The body and the response's head (status line and headers).
    await waitFor(() => entry().bytes.down > "hello from the far end".length);
    expect(entry().bytes.down).toBeLessThan(400);
    expect(entry().bytes.up).toBeGreaterThan(30); // the request's head
  });

  it("plain HTTP through a SOCKS5 proxy that refuses the credentials is reported", async () => {
    const p = await listen(socksServer(() => "bad-auth", []));
    rig = await makeRig(socks(), p);
    const a = await send(
      "GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n",
    );
    expect(a.status).toBe(502);
    expect(a.reason).toBe("upstream_auth_failed");
    onlyTheProxyWasDialed();
  });
});

// --- TLS to the proxy ------------------------------------------------------------------------

describe("TLS to an https:// proxy", () => {
  const https = (
    host = "proxy.test",
  ): NonNullable<EgressPolicy["upstream"]> => ({
    scheme: "https",
    host,
    port: 443,
    username: "u",
    password: PASSWORD,
  });

  it("verifies the certificate for the proxy's name, sends SNI, then CONNECTs inside", async () => {
    const heads: string[] = [];
    const sni: (string | false)[] = [];
    const p = await listen(tlsProxy(certs.key, certs.cert, heads, sni));
    rig = await makeRig(https(), p);
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(sni).toEqual(["proxy.test"]);
    const lines = heads[0]!.split("\r\n");
    expect(lines[0]).toBe("CONNECT public.test:443 HTTP/1.1");
    expect(lines).toContain(
      "Proxy-Authorization: Basic " +
        Buffer.from(`u:${PASSWORD}`).toString("base64"),
    );
    const payload = Buffer.from("over tls to the proxy");
    expect((await echo(t, payload)).toString()).toBe(payload.toString());
    onlyTheProxyWasDialed();
    t.socket.destroy();
  });

  it("an IP-address proxy needs the address in its certificate, and gets no SNI", async () => {
    const sni: (string | false)[] = [];
    const p = await listen(tlsProxy(certs.key, certs.cert, [], sni));
    rig = await makeRig(https(PROXY_IP), p);
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(sni).toEqual([false]);
    t.socket.destroy();
  });

  it.each([
    ["a certificate from an untrusted CA", "untrusted"],
    ["a certificate for another name", "wrong-name"],
    ["a proxy that does not speak TLS", "plain"],
  ] as const)(
    "%s is upstream_tls_failed, and nothing goes direct",
    async (_what, kind) => {
      const open = new Set<Socket>();
      const p =
        kind === "plain"
          ? await listen(
              createTcp((s) => {
                open.add(s);
                s.on("close", () => open.delete(s));
                s.on("error", () => undefined);
                s.resume(); // read, so the gateway's close is seen
                s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
              }),
            )
          : await listen(
              tlsProxy(
                kind === "wrong-name" ? certs.wrongKey : certs.key,
                kind === "wrong-name" ? certs.wrongName : certs.cert,
                [],
                [],
              ),
            );
      rig = await makeRig(https(), p, {
        ca: kind === "untrusted" ? [] : [certs.ca],
      });
      const t = await tunnel("public.test:443");
      expect(t.status).toBe(502);
      expect(t.reason).toBe("upstream_tls_failed");
      onlyTheProxyWasDialed();
      expect(reasons()).toEqual(["upstream_tls_failed"]);
      await waitFor(() => entry().active === 0);
      // The gateway let go of its connection to the proxy.
      await waitFor(() => open.size === 0);
    },
  );

  it("plain HTTP goes to the proxy over TLS, in absolute-URI form", async () => {
    const heads: string[] = [];
    const p = await listen(tlsProxy(certs.key, certs.cert, heads, []));
    rig = await makeRig(https(), p);
    const a = await send(
      "GET http://public.test/x HTTP/1.1\r\nHost: public.test\r\n\r\n",
    );
    expect(a.status).toBe(200);
    expect(await readAll(a)).toBe(
      "via tls proxy: GET http://public.test/x HTTP/1.1",
    );
    expect(heads[0]).toContain("proxy-authorization: Basic");
    onlyTheProxyWasDialed();
  });

  it("plain HTTP through an untrusted proxy is refused before anything is sent", async () => {
    const heads: string[] = [];
    const p = await listen(tlsProxy(certs.key, certs.cert, heads, []));
    rig = await makeRig(https(), p, { ca: [] });
    const a = await send(
      "GET http://public.test/x HTTP/1.1\r\nHost: public.test\r\n\r\n",
    );
    expect(a.status).toBe(502);
    expect(a.reason).toBe("upstream_tls_failed");
    expect(heads).toEqual([]);
  });
});

// --- bytes without a proxy -------------------------------------------------------------------

describe("byte counters (G-20)", () => {
  it("count a plain HTTP request up and its response down, heads and bodies, per session", async () => {
    rig = await makeRig(undefined, 0);
    const body = "x".repeat(5000);
    const a = await send(
      `POST http://public.test/upload HTTP/1.1\r\nHost: public.test\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
    );
    expect(a.status).toBe(200);
    const text = await readAll(a);
    expect(text).toBe("direct, 5000 bytes received");
    // Bodies, plus each head as it crossed: line, headers and the blank line.
    await waitFor(() => entry().bytes.down > text.length);
    expect(entry().bytes.down).toBeLessThan(text.length + 300);
    expect(entry().bytes.up).toBeGreaterThan(5000);
    expect(entry().bytes.up).toBeLessThan(5000 + 300);
  });

  it("survive a policy update for the same session and are handed over when it is cleared", async () => {
    const p = await listen(socksServer(() => "ok", []));
    rig = await makeRig(socks(), p);
    const t = await tunnel("public.test:443");
    await echo(t, Buffer.alloc(3000, 1));
    await waitFor(() => entry().bytes.down === 3000);
    rig.policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      connectionCap: 256,
      upstream: socks(),
    });
    expect(entry().bytes).toEqual({ up: 3000, down: 3000 });
    expect(rig.policies.delete("127.0.0.1")).toEqual({
      sessionId: SESSION,
      bytes: { up: 3000, down: 3000 },
    });
  });
});
