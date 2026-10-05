import { createServer as createHttp, type Server } from "node:http";
import {
  connect,
  createServer as createTcp,
  type AddressInfo,
  type Socket,
} from "node:net";
import { newId, type EgressPolicy } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";
import { EgressProxy } from "./proxy.js";
import type { Resolver } from "./resolver.js";
import { parseConnectReply } from "./upstream.js";

const SESSION = newId("ses");
const PUBLIC = "93.184.216.34";
/** Where proxy.test resolves: a public address, served by the fake proxy below. */
const PROXY_IP = "93.184.216.40";
const PASSWORD = "pr0xy-pa55";
const BASIC = "Basic " + Buffer.from(`u:${PASSWORD}`).toString("base64");

class StubResolver implements Resolver {
  answers = new Map<string, string[]>();
  calls: string[] = [];
  async resolve4(name: string) {
    this.calls.push(name);
    return this.answers.get(name) ?? [];
  }
}

/** How the fake proxy answers a request head; `rest` is whatever followed it. */
type Mode = (sock: Socket, head: string, rest: Buffer) => void;

/** The fake proxy's default: open tunnels as an echo, answer plain requests with their line. */
const goodProxy: Mode = (s, head, rest) => {
  if (head.startsWith("CONNECT ")) {
    s.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (rest.length) s.write(rest);
    s.pipe(s);
    return;
  }
  const body = `via proxy: ${head.split("\r\n")[0]}`;
  s.end(
    `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
  );
};

const replyWith =
  (text: string | Buffer): Mode =>
  (s) => {
    s.write(text);
  };

interface Rig {
  port: number;
  policies: PolicyStore;
  resolver: StubResolver;
  denials: DenialLog;
  dialed: { ip: string; port: number }[];
  /** Every request head the fake proxy received. */
  heads: string[];
  /** Sockets the fake proxy holds open. */
  proxySockets: Set<Socket>;
  mode: Mode;
  proxyDown: boolean;
  close(): Promise<void>;
}

let rig: Rig;
afterEach(async () => rig?.close());

async function makeRig(
  opts: {
    upstream?: EgressPolicy["upstream"] | null;
    cap?: number;
    blocked?: string[];
    replyTimeoutMs?: number;
    allow?: string[];
    deny?: string[];
  } = {},
): Promise<Rig> {
  const policies = new PolicyStore();
  const upstream =
    opts.upstream === null
      ? undefined
      : (opts.upstream ?? {
          host: "proxy.test",
          port: 3128,
          username: "u",
          password: PASSWORD,
        });
  policies.set("127.0.0.1", {
    sessionId: SESSION as never,
    connectionCap: opts.cap ?? 256,
    ...(opts.allow ? { allow: opts.allow } : {}),
    ...(opts.deny ? { deny: opts.deny } : {}),
    ...(upstream ? { upstream } : {}),
  });
  const resolver = new StubResolver();
  resolver.answers.set("public.test", [PUBLIC]);
  resolver.answers.set("proxy.test", [PROXY_IP]);
  const denials = new DenialLog();
  const dialed: Rig["dialed"] = [];
  const heads: string[] = [];
  const proxySockets = new Set<Socket>();

  // Destinations: if anything ever reaches these in a proxied test, the gateway went direct.
  const origin: Server = createHttp((_req, res) => res.end("direct!"));
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = (origin.address() as AddressInfo).port;

  const r = {} as Rig;
  const fakeProxy = createTcp((s) => {
    proxySockets.add(s);
    s.on("close", () => proxySockets.delete(s));
    s.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      heads.push(head);
      r.mode(s, head, buf.subarray(end + 4));
    };
    s.on("data", onData);
  });
  await new Promise<void>((res) => fakeProxy.listen(0, "127.0.0.1", res));
  const proxyPort = (fakeProxy.address() as AddressInfo).port;
  // A port with nothing listening, for a proxy that is down.
  const dead = createTcp();
  await new Promise<void>((res) => dead.listen(0, "127.0.0.1", res));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((res) => dead.close(() => res()));

  const proxy = new EgressProxy({
    policies,
    resolver,
    denials,
    metrics: createEgressMetrics(),
    log: createLogger("t", "silent"),
    blockedAddresses: new Set(opts.blocked ?? []),
    connectTimeoutMs: 2000,
    idleTimeoutMs: 60_000,
    upstreamReplyTimeoutMs: opts.replyTimeoutMs ?? 2000,
    connect: (ip, port) => {
      dialed.push({ ip, port });
      if (ip === PROXY_IP)
        return connect({
          host: "127.0.0.1",
          port: r.proxyDown ? deadPort : proxyPort,
        });
      return connect({ host: "127.0.0.1", port: originPort });
    },
  });
  const port = await proxy.listen("127.0.0.1", 0);
  Object.assign(r, {
    port,
    policies,
    resolver,
    denials,
    dialed,
    heads,
    proxySockets,
    mode: goodProxy,
    proxyDown: false,
    close: async () => {
      await proxy.close();
      for (const s of proxySockets) s.destroy();
      await new Promise<void>((res) => fakeProxy.close(() => res()));
      origin.closeAllConnections();
      await new Promise<void>((res) => origin.close(() => res()));
    },
  });
  return r;
}

interface Answer {
  status: number;
  reason: string | undefined;
  head: string;
  socket: Socket;
  rest: string;
}

/** Send raw bytes as Chrome would and return the gateway's answer head. */
function send(raw: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port: rig.port });
    let buf = "";
    s.on("error", reject);
    s.on("data", function onData(d) {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = buf.slice(0, end);
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]),
        reason: /x-kestrel-egress-denied: (\S+)/i.exec(head)?.[1],
        head,
        socket: s,
        rest: buf.slice(end + 4),
      });
    });
    s.write(raw);
  });
}

const tunnel = (target: string): Promise<Answer> =>
  send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

/** Read until the socket closes, returning everything after the head. */
const readAll = (a: Answer): Promise<string> =>
  new Promise((resolve) => {
    let body = a.rest;
    a.socket.on("data", (d) => (body += d.toString("latin1")));
    a.socket.on("close", () => resolve(body));
  });

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const entry = () => rig.policies.get("127.0.0.1")!;
/** The gateway never went to a destination itself: every connection was to the proxy. */
const onlyTheProxyWasDialed = () => {
  expect(rig.dialed.every((d) => d.ip === PROXY_IP)).toBe(true);
  expect(rig.resolver.calls).not.toContain("public.test");
};
const denialsFor = () =>
  rig.denials
    .read(0)
    .map((d) => ({ host: d.host, port: d.port, reason: d.reason }));

describe("CONNECT through the session's proxy", () => {
  it("asks the proxy for the destination by name, with our credentials, and relays both ways", async () => {
    rig = await makeRig();
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(rig.heads).toHaveLength(1);
    const lines = rig.heads[0]!.split("\r\n");
    expect(lines[0]).toBe("CONNECT public.test:443 HTTP/1.1");
    expect(lines).toContain("Host: public.test:443");
    expect(lines).toContain(`Proxy-Authorization: ${BASIC}`);
    expect(rig.dialed).toEqual([{ ip: PROXY_IP, port: 3128 }]);
    expect(rig.resolver.calls).toEqual(["proxy.test"]);
    const echoed = new Promise<string>((r) =>
      t.socket.once("data", (d) => r(d.toString())),
    );
    t.socket.write("ping through the proxy");
    expect(await echoed).toBe("ping through the proxy");
    expect(entry().active).toBe(1);
    t.socket.destroy();
    await waitFor(() => entry().active === 0);
  });

  it("passes on bytes the proxy sent straight after its 2xx, after our own 200", async () => {
    rig = await makeRig();
    rig.mode = (s) => {
      s.write("HTTP/1.1 200 OK\r\nX-Proxy: yes\r\n\r\nearly bytes");
      s.pipe(s);
    };
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(t.head).not.toContain("X-Proxy");
    const got = t.rest.length
      ? t.rest
      : await new Promise<string>((r) =>
          t.socket.once("data", (d) => r(d.toString())),
        );
    expect(got).toBe("early bytes");
    t.socket.destroy();
  });

  it("sends no Proxy-Authorization without a username", async () => {
    rig = await makeRig({ upstream: { host: "proxy.test", port: 3128 } });
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(rig.heads[0]).not.toMatch(/proxy-authorization/i);
    t.socket.destroy();
  });

  it("asks for a public literal address by its address", async () => {
    rig = await makeRig();
    const t = await tunnel(`${PUBLIC}:443`);
    expect(t.status).toBe(200);
    expect(rig.heads[0]!.split("\r\n")[0]).toBe(
      `CONNECT ${PUBLIC}:443 HTTP/1.1`,
    );
    t.socket.destroy();
  });

  it("reports a 407 as upstream_auth_failed, and passes nothing of the proxy's reply on", async () => {
    rig = await makeRig();
    rig.mode = replyWith(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="secret-realm"\r\n\r\n',
    );
    const t = await tunnel("public.test:443");
    expect({ status: t.status, reason: t.reason }).toEqual({
      status: 502,
      reason: "upstream_auth_failed",
    });
    expect(t.head + (await readAll(t))).not.toContain("secret-realm");
    expect(denialsFor()).toEqual([
      { host: "public.test", port: 443, reason: "upstream_auth_failed" },
    ]);
    expect(entry().active).toBe(0);
    onlyTheProxyWasDialed();
  });

  it.each([
    ["a 403", "HTTP/1.1 403 Forbidden\r\n\r\n"],
    ["a 502", "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"],
    ["a redirect", "HTTP/1.1 301 Moved\r\nLocation: http://evil.test/\r\n\r\n"],
    ["100 Continue", "HTTP/1.1 100 Continue\r\n\r\n"],
    ["101 Switching Protocols", "HTTP/1.1 101 Switching Protocols\r\n\r\n"],
    ["an SMTP banner", "220 mail.example.com ESMTP\r\n\r\n"],
    ["HTTP/2", "HTTP/2 200\r\n\r\n"],
    ["a four-digit status", "HTTP/1.1 2000 OK\r\n\r\n"],
    ["a bare LF", "HTTP/1.1 200 OK\nX-Smuggled: 1\r\n\r\n"],
    ["a NUL", "HTTP/1.1 200 OK\r\nX-A: \u0000\r\n\r\n"],
    ["a header without a colon", "HTTP/1.1 200 OK\r\nnot a header\r\n\r\n"],
  ])("refuses %s as upstream_refused", async (_name, reply) => {
    rig = await makeRig();
    rig.mode = replyWith(reply);
    const t = await tunnel("public.test:443");
    expect({ status: t.status, reason: t.reason }).toEqual({
      status: 502,
      reason: "upstream_refused",
    });
    expect(entry().active).toBe(0);
    await waitFor(() => rig.proxySockets.size === 0);
    onlyTheProxyWasDialed();
  });

  it("refuses a reply head larger than 16 KiB", async () => {
    rig = await makeRig();
    rig.mode = (s) => {
      s.write("HTTP/1.1 200 OK\r\n");
      s.write(`X-Big: ${"a".repeat(17 * 1024)}`);
    };
    const t = await tunnel("public.test:443");
    expect(t.reason).toBe("upstream_refused");
    await waitFor(() => rig.proxySockets.size === 0);
  });

  it("gives up on a proxy that trickles its reply, at one deadline for the whole reply", async () => {
    rig = await makeRig({ replyTimeoutMs: 300 });
    rig.mode = (s) => {
      const bytes = "HTTP/1.1 200 OK\r\nX-Slow: yes\r\n\r\n";
      let i = 0;
      const t = setInterval(() => {
        if (s.destroyed || i >= bytes.length) return clearInterval(t);
        s.write(bytes[i++]!);
      }, 50);
    };
    const started = Date.now();
    const t = await tunnel("public.test:443");
    expect({ status: t.status, reason: t.reason }).toEqual({
      status: 504,
      reason: "upstream_unreachable",
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(entry().active).toBe(0);
  });

  it("reports a proxy that closes before replying, or is down, as upstream_unreachable", async () => {
    rig = await makeRig();
    rig.mode = (s) => s.destroy();
    const closed = await tunnel("public.test:443");
    expect({ status: closed.status, reason: closed.reason }).toEqual({
      status: 502,
      reason: "upstream_unreachable",
    });
    rig.proxyDown = true;
    const down = await tunnel("public.test:443");
    expect(down.reason).toBe("upstream_unreachable");
    expect(entry().active).toBe(0);
    onlyTheProxyWasDialed();
  });
});

describe("the proxy's own address (T-44, T-48)", () => {
  it.each([
    ["a private address", ["10.0.0.5"]],
    ["the metadata service", ["169.254.169.254"]],
    ["loopback", ["127.0.0.1"]],
    ["a public and a private answer", [PROXY_IP, "192.168.1.1"]],
  ])("refuses a proxy name resolving to %s", async (_name, answers) => {
    rig = await makeRig();
    rig.resolver.answers.set("proxy.test", answers);
    const t = await tunnel("public.test:443");
    expect({ status: t.status, reason: t.reason }).toEqual({
      status: 403,
      reason: "upstream_blocked",
    });
    expect(rig.dialed).toEqual([]);
    expect(entry().active).toBe(0);
  });

  it("refuses the host's own address, a private literal and a bad port", async () => {
    rig = await makeRig({ blocked: [PROXY_IP] });
    expect((await tunnel("public.test:443")).reason).toBe("upstream_blocked");
    await rig.close();
    rig = await makeRig({ upstream: { host: "10.1.2.3", port: 3128 } });
    expect((await tunnel("public.test:443")).reason).toBe("upstream_blocked");
    await rig.close();
    rig = await makeRig({ upstream: { host: "proxy.test", port: 25 } });
    expect((await tunnel("public.test:443")).reason).toBe("upstream_blocked");
    expect(rig.dialed).toEqual([]);
  });

  it("reports a proxy name that does not resolve as upstream_unreachable", async () => {
    rig = await makeRig();
    rig.resolver.answers.set("proxy.test", []);
    const t = await tunnel("public.test:443");
    expect({ status: t.status, reason: t.reason }).toEqual({
      status: 502,
      reason: "upstream_unreachable",
    });
    expect(rig.dialed).toEqual([]);
  });

  it("connects to a literal proxy address without resolving anything", async () => {
    rig = await makeRig({ upstream: { host: PROXY_IP, port: 8080 } });
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(rig.resolver.calls).toEqual([]);
    expect(rig.dialed).toEqual([{ ip: PROXY_IP, port: 8080 }]);
    t.socket.destroy();
  });
});

describe("the destination rules still apply through a proxy", () => {
  it("refuses other ports, listed hosts and private literals before reaching the proxy", async () => {
    rig = await makeRig({ deny: ["denied.test"] });
    expect((await tunnel("public.test:22")).reason).toBe("port_not_allowed");
    expect((await tunnel("denied.test:443")).reason).toBe("in_deny_list");
    expect((await tunnel("10.0.0.1:443")).reason).toBe("blocked_address");
    expect((await tunnel("169.254.169.254:80")).reason).toBe("blocked_address");
    await rig.close();
    rig = await makeRig({ allow: ["allowed.test"] });
    expect((await tunnel("public.test:443")).reason).toBe("not_in_allow_list");
    const ok = await tunnel("allowed.test:443");
    expect(ok.status).toBe(200);
    ok.socket.destroy();
    expect(rig.heads).toHaveLength(1);
  });
});

describe("plain HTTP through the session's proxy", () => {
  const get = (path: string, extra = "") =>
    send(
      `GET http://public.test${path} HTTP/1.1\r\nHost: public.test\r\n${extra}\r\n`,
    );

  it("forwards the absolute URI by name, with our credentials and never Chrome's", async () => {
    rig = await makeRig();
    const a = await get("/page?q=1", "Proxy-Authorization: Basic Y2hyb21l\r\n");
    expect(a.status).toBe(200);
    expect(await readAll(a)).toBe(
      "via proxy: GET http://public.test/page?q=1 HTTP/1.1",
    );
    const lines = rig.heads[0]!.split("\r\n").map((l) => l.toLowerCase());
    expect(lines).toContain("host: public.test");
    expect(lines).toContain(`proxy-authorization: ${BASIC.toLowerCase()}`);
    expect(lines).not.toContain("proxy-authorization: basic y2hyb21l");
    onlyTheProxyWasDialed();
    await waitFor(() => entry().active === 0);
  });

  it("reports a 407 and a proxy that is down, and passes other statuses through", async () => {
    rig = await makeRig();
    rig.mode = (s) =>
      s.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    const auth = await get("/");
    expect({ status: auth.status, reason: auth.reason }).toEqual({
      status: 502,
      reason: "upstream_auth_failed",
    });
    rig.mode = (s) =>
      s.end(
        "HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
      );
    const missing = await get("/missing");
    expect(missing.status).toBe(404);
    expect(missing.reason).toBeUndefined();
    rig.proxyDown = true;
    const down = await get("/");
    expect({ status: down.status, reason: down.reason }).toEqual({
      status: 502,
      reason: "upstream_unreachable",
    });
    expect(denialsFor().map((d) => d.reason)).toEqual([
      "upstream_auth_failed",
      "upstream_unreachable",
    ]);
    onlyTheProxyWasDialed();
  });
});

describe("accounting and lifetimes", () => {
  const hang: Mode = () => undefined;

  it("counts a handshake against the cap, and gives the slot back when it times out", async () => {
    rig = await makeRig({ cap: 2, replyTimeoutMs: 400 });
    rig.mode = hang;
    const first = tunnel("public.test:443");
    const second = tunnel("public.test:443");
    await waitFor(() => rig.heads.length === 2);
    expect(entry().active).toBe(2);
    expect((await tunnel("public.test:443")).reason).toBe("connection_cap");
    expect((await first).reason).toBe("upstream_unreachable");
    expect((await second).reason).toBe("upstream_unreachable");
    expect(entry().active).toBe(0);
  });

  it("drops the proxy connection and the slot when the client leaves mid-handshake", async () => {
    rig = await makeRig();
    rig.mode = hang;
    const s = connect({ host: "127.0.0.1", port: rig.port });
    s.on("error", () => undefined);
    s.write(
      "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
    );
    await waitFor(() => rig.heads.length === 1);
    s.destroy();
    await waitFor(() => rig.proxySockets.size === 0);
    await waitFor(() => entry().active === 0);
  });

  it("cuts a handshake when the policy is cleared, and opens no tunnel", async () => {
    rig = await makeRig();
    rig.mode = hang;
    const s = connect({ host: "127.0.0.1", port: rig.port });
    s.on("error", () => undefined);
    const closed = new Promise<void>((r) => s.on("close", () => r()));
    let got = "";
    s.on("data", (d) => (got += d.toString()));
    s.write(
      "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
    );
    await waitFor(() => rig.heads.length === 1);
    rig.policies.delete("127.0.0.1");
    await closed;
    expect(got).not.toContain("200");
    await waitFor(() => rig.proxySockets.size === 0);
  });

  it("cuts open tunnels when the session's proxy changes, and keeps them when it does not", async () => {
    rig = await makeRig();
    const t = await tunnel("public.test:443");
    const closed = new Promise<void>((r) => t.socket.on("close", () => r()));
    const same = {
      sessionId: SESSION as never,
      connectionCap: 256,
      upstream: {
        host: "proxy.test",
        port: 3128,
        username: "u",
        password: PASSWORD,
      },
    };
    rig.policies.set("127.0.0.1", same);
    expect(t.socket.destroyed).toBe(false);
    expect(entry().sockets.size).toBe(1);
    rig.policies.set("127.0.0.1", {
      ...same,
      upstream: { ...same.upstream, password: "rotated" },
    });
    await closed;
  });

  it("without a proxy, goes direct as before", async () => {
    rig = await makeRig({ upstream: null });
    const t = await tunnel("public.test:443");
    expect(t.status).toBe(200);
    expect(rig.dialed).toEqual([{ ip: PUBLIC, port: 443 }]);
    expect(rig.heads).toEqual([]);
    t.socket.destroy();
  });
});

describe("parseConnectReply", () => {
  const parse = (s: string) =>
    parseConnectReply(Buffer.from(s, "latin1"), Buffer.alloc(0)).kind;

  it("accepts HTTP/1.0 and 1.1 2xx with or without a reason", () => {
    expect(parse("HTTP/1.1 200 Connection established")).toBe("ok");
    expect(parse("HTTP/1.0 200")).toBe("ok");
    expect(parse("HTTP/1.1 204 No Content\r\nVia: 1.1 proxy")).toBe("ok");
    expect(parse("HTTP/1.1 407 Proxy Authentication Required")).toBe("auth");
    expect(
      parse("HTTP/1.1 200 OK\r\n" + "X-A: b\r\n".repeat(101).trimEnd()),
    ).toBe("refused");
  });
});
