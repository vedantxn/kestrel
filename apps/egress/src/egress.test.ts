import { createServer as createHttp, type Server } from "node:http";
import {
  connect,
  createServer as createTcp,
  type AddressInfo,
  type Socket,
} from "node:net";
import { request } from "node:http";
import { newId } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import { isPublicUnicastIPv4, parseHost } from "./addresses.js";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";
import { EgressProxy } from "./proxy.js";
import type { Resolver } from "./resolver.js";

const SESSION = newId("ses");
const PUBLIC = "93.184.216.34";

class StubResolver implements Resolver {
  answers = new Map<string, string[]>();
  calls: string[] = [];
  async resolve4(name: string) {
    this.calls.push(name);
    return this.answers.get(name) ?? [];
  }
}

interface Rig {
  proxy: EgressProxy;
  port: number;
  policies: PolicyStore;
  resolver: StubResolver;
  denials: DenialLog;
  dialed: { ip: string; port: number }[];
  /** A TCP echo server standing in for every public destination. */
  echoPort: number;
  /** An HTTP server standing in for every public web server. */
  seen: { method?: string; url?: string; headers: Record<string, unknown> }[];
  close(): Promise<void>;
}

let rig: Rig;
afterEach(async () => rig?.close());

async function makeRig(
  opts: {
    blocked?: string[];
    cap?: number;
    policy?: boolean;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
  } = {},
): Promise<Rig> {
  const policies = new PolicyStore();
  if (opts.policy !== false)
    policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      connectionCap: opts.cap ?? 256,
    });
  const resolver = new StubResolver();
  resolver.answers.set("public.test", [PUBLIC]);
  const denials = new DenialLog();
  const dialed: { ip: string; port: number }[] = [];
  const seen: Rig["seen"] = [];

  const httpServer: Server = createHttp((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader("x-upstream", "yes");
    res.setHeader("connection", "keep-alive");
    res.end(`hello ${req.url}`);
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const httpPort = (httpServer.address() as AddressInfo).port;
  const echoSockets = new Set<Socket>();
  const echo = createTcp((s) => {
    echoSockets.add(s);
    s.on("close", () => echoSockets.delete(s));
    s.on("error", () => undefined);
    s.pipe(s);
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as AddressInfo).port;

  const proxy = new EgressProxy({
    policies,
    resolver,
    denials,
    metrics: createEgressMetrics(),
    log: createLogger("t", "silent"),
    blockedAddresses: new Set(opts.blocked ?? []),
    connectTimeoutMs: opts.connectTimeoutMs ?? 2000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    // Every checked destination is really a local server; what matters is which address was asked for.
    connect: (ip, port) => {
      dialed.push({ ip, port });
      return connect({
        host: "127.0.0.1",
        port: port === 80 ? httpPort : echoPort,
      });
    },
  });
  const port = await proxy.listen("127.0.0.1", 0);
  return {
    proxy,
    port,
    policies,
    resolver,
    denials,
    dialed,
    echoPort,
    seen,
    close: async () => {
      await proxy.close();
      for (const s of echoSockets) s.destroy();
      await new Promise<void>((r) => echo.close(() => r()));
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

/** Send a CONNECT and return the status line, the denial header and the socket. */
function tunnel(
  target: string,
  port: number,
): Promise<{
  status: number;
  reason: string | undefined;
  socket: Socket;
  rest: string;
}> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let buf = "";
    s.on("error", reject);
    s.on("data", function onData(d) {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const head = buf.slice(0, end);
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
      const reason = /x-kestrel-egress-denied: (\S+)/i.exec(head)?.[1];
      resolve({ status, reason, socket: s, rest: buf.slice(end + 4) });
    });
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

const deniedWith = async (target: string, reason: string, status = 403) => {
  const t = await tunnel(target, rig.port);
  expect({ target, status: t.status, reason: t.reason }).toEqual({
    target,
    status,
    reason,
  });
  t.socket.destroy();
};

describe("which addresses count as public (N7)", () => {
  it("allows ordinary public IPv4 and nothing else", () => {
    for (const ok of [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "142.250.80.46",
      "100.63.255.255",
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "192.169.0.1",
    ]) {
      expect(isPublicUnicastIPv4(ok), ok).toBe(true);
    }
    for (const bad of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.100.100.200",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "169.254.170.2",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "::1",
      "::ffff:169.254.169.254",
      "2606:4700::1111",
      "fe80::1",
      "not an address",
      "",
    ]) {
      expect(isPublicUnicastIPv4(bad), bad).toBe(false);
    }
  });

  it("normalises every spelling of an address the way a browser would (G-06)", () => {
    const ip = (s: string) => parseHost(s);
    expect(ip("2852039166")).toEqual({ kind: "ip", ip: "169.254.169.254" }); // decimal
    expect(ip("0xa9fea9fe")).toEqual({ kind: "ip", ip: "169.254.169.254" }); // hex
    expect(ip("0251.0376.0251.0376")).toEqual({
      kind: "ip",
      ip: "169.254.169.254",
    }); // octal
    expect(ip("169.254.43518")).toEqual({ kind: "ip", ip: "169.254.169.254" }); // mixed
    expect(ip("127.1")).toEqual({ kind: "ip", ip: "127.0.0.1" });
    expect(ip("0")).toEqual({ kind: "ip", ip: "0.0.0.0" });
    expect(ip("[::1]")).toEqual({ kind: "ip", ip: "::1" });
    expect(ip("[::ffff:169.254.169.254]").kind).toBe("ip");
    expect(ip("Example.COM.")).toEqual({ kind: "name", name: "example.com" });
    for (const bad of [
      "",
      "a b",
      "user@host",
      "host/path",
      "ho%73t",
      "a..b",
      "-bad.com",
      "1.2.3.4.5",
      "999.999.999.999",
    ]) {
      expect(parseHost(bad).kind, bad).toBe("invalid");
    }
  });
});

describe("identity and ports (N6, N9)", () => {
  it("refuses everything for an address with no policy, then allows once one exists, and cuts tunnels when it is cleared", async () => {
    rig = await makeRig({ policy: false });
    await deniedWith("public.test:443", "no_policy");
    rig.policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      connectionCap: 256,
    });
    const t = await tunnel("public.test:443", rig.port);
    expect(t.status).toBe(200);
    t.socket.write("ping");
    await new Promise<void>((r) => t.socket.once("data", () => r()));
    const closed = new Promise<void>((r) => t.socket.once("close", () => r()));
    rig.policies.delete("127.0.0.1"); // G10: clearing the policy cuts its tunnels at once
    await closed;
    await deniedWith("public.test:443", "no_policy");
  });

  it("allows only ports 80 and 443", async () => {
    rig = await makeRig();
    for (const p of [22, 25, 3306, 6379, 8080, 8443, 9222, 65535, 1])
      await deniedWith(`public.test:${p}`, "port_not_allowed");
    for (const p of [80, 443]) {
      const t = await tunnel(`public.test:${p}`, rig.port);
      expect(t.status).toBe(200);
      t.socket.destroy();
    }
  });

  it("relays bytes both ways through an allowed tunnel", async () => {
    rig = await makeRig();
    const t = await tunnel("public.test:443", rig.port);
    const payload = Buffer.alloc(2 * 1024 * 1024, 7);
    const got: Buffer[] = [];
    t.socket.on("data", (d) => got.push(d));
    t.socket.write(payload);
    const until = Date.now() + 5000;
    while (Buffer.concat(got).length < payload.length && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.concat(got).length).toBe(payload.length);
    t.socket.destroy();
  });
});

describe("the block list through CONNECT (N7, N8, G-06)", () => {
  const targets: [string, string][] = [
    ["169.254.169.254:80", "AWS metadata"],
    ["169.254.170.2:80", "ECS credentials"],
    ["127.0.0.1:80", "loopback"],
    ["10.0.0.5:443", "private"],
    ["172.16.0.1:443", "private"],
    ["192.168.1.1:80", "private"],
    ["100.64.0.1:80", "carrier-grade NAT"],
    ["100.100.100.200:80", "Alibaba metadata"],
    ["0.0.0.0:80", "this network"],
    ["224.0.0.1:80", "multicast"],
    ["255.255.255.255:80", "broadcast"],
    ["198.18.0.1:80", "benchmarking"],
    ["2852039166:80", "decimal metadata"],
    ["0xa9fea9fe:80", "hex metadata"],
    ["0251.0376.0251.0376:80", "octal metadata"],
    ["127.1:80", "short loopback"],
    ["[::1]:80", "IPv6 loopback"],
    ["[::ffff:169.254.169.254]:80", "IPv4-mapped metadata"],
    ["[::ffff:a9fe:a9fe]:80", "hex IPv4-mapped metadata"],
    ["[2606:4700::1111]:443", "any IPv6, even a public one"],
    ["[64:ff9b::a9fe:a9fe]:80", "NAT64 metadata"],
    ["[2002:a9fe:a9fe::]:80", "6to4 metadata"],
  ];
  for (const [target, why] of targets) {
    it(`refuses ${target} (${why})`, async () => {
      rig = await makeRig();
      const t = await tunnel(target, rig.port);
      expect(t.status === 403 || t.status === 400).toBe(true);
      expect(t.reason).toBe("blocked_address");
      expect(rig.dialed).toEqual([]);
      t.socket.destroy();
    });
  }

  it("refuses a name that resolves to an internal address, and a name with mixed answers", async () => {
    rig = await makeRig();
    rig.resolver.answers.set("internal.test", ["169.254.169.254"]);
    rig.resolver.answers.set("mixed.test", [PUBLIC, "10.0.0.5"]);
    rig.resolver.answers.set("rebinding.test", ["127.0.0.1"]);
    for (const n of ["internal.test", "mixed.test", "rebinding.test"])
      await deniedWith(`${n}:80`, "blocked_address");
    expect(rig.dialed).toEqual([]);
  });

  it("refuses the host's own address, so a session cannot call the platform's public endpoints", async () => {
    rig = await makeRig({ blocked: ["54.1.2.3"] });
    rig.resolver.answers.set("platform.test", ["54.1.2.3"]);
    await deniedWith("platform.test:443", "blocked_address");
    await deniedWith("54.1.2.3:443", "blocked_address");
  });

  it("resolves once and connects to the address it checked, not to the name (N8)", async () => {
    rig = await makeRig();
    const t = await tunnel("public.test:443", rig.port);
    expect(t.status).toBe(200);
    expect(rig.resolver.calls).toEqual(["public.test"]);
    expect(rig.dialed).toEqual([{ ip: PUBLIC, port: 443 }]);
    t.socket.destroy();
  });

  it("answers 502 for a name that does not resolve and for malformed targets", async () => {
    rig = await makeRig();
    await deniedWith("nonexistent.test:443", "resolve_failed", 502);
    for (const bad of [
      "no-port",
      "host:abc",
      "host:99999999",
      "us%65r@host:80",
    ]) {
      const t = await tunnel(bad, rig.port);
      expect([400, 403]).toContain(t.status);
      t.socket.destroy();
    }
  });
});

describe("per-session allow and deny lists (N10)", () => {
  it("applies an allow list, wildcards, and deny precedence", async () => {
    rig = await makeRig();
    rig.policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      allow: ["public.test", "*.allowed.test"],
      deny: ["bad.allowed.test"],
      connectionCap: 256,
    });
    for (const n of ["public.test", "x.allowed.test", "a.b.allowed.test"])
      rig.resolver.answers.set(n, [PUBLIC]);
    rig.resolver.answers.set("bad.allowed.test", [PUBLIC]);
    rig.resolver.answers.set("other.test", [PUBLIC]);
    rig.resolver.answers.set("allowed.test.evil.com", [PUBLIC]);
    for (const ok of ["public.test", "x.allowed.test", "a.b.allowed.test"]) {
      const t = await tunnel(`${ok}:443`, rig.port);
      expect(t.status, ok).toBe(200);
      t.socket.destroy();
    }
    await deniedWith("bad.allowed.test:443", "in_deny_list");
    await deniedWith("other.test:443", "not_in_allow_list");
    await deniedWith("allowed.test:443", "not_in_allow_list"); // the apex is not matched by *.
    await deniedWith("allowed.test.evil.com:443", "not_in_allow_list");
    await deniedWith("93.184.216.34:443", "not_in_allow_list"); // a bare address never matches a name
  });

  it("applies a deny list alone", async () => {
    rig = await makeRig();
    rig.policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      deny: ["*.ads.test"],
      connectionCap: 256,
    });
    rig.resolver.answers.set("x.ads.test", [PUBLIC]);
    await deniedWith("x.ads.test:443", "in_deny_list");
    expect((await tunnel("public.test:443", rig.port)).status).toBe(200);
  });
});

describe("the connection cap (N11)", () => {
  it("refuses beyond the cap with 503, and frees a place when a connection closes", async () => {
    rig = await makeRig({ cap: 3 });
    const open = [];
    for (let i = 0; i < 3; i++)
      open.push(await tunnel("public.test:443", rig.port));
    expect(open.every((t) => t.status === 200)).toBe(true);
    await deniedWith("public.test:443", "connection_cap", 503);
    open[0]!.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect((await tunnel("public.test:443", rig.port)).status).toBe(200);
  });

  it("replacing a policy keeps tunnels for the same session, and cuts them for a different one", async () => {
    rig = await makeRig();
    const t = await tunnel("public.test:443", rig.port);
    rig.policies.set("127.0.0.1", {
      sessionId: SESSION as never,
      connectionCap: 5,
    });
    expect(rig.policies.get("127.0.0.1")?.active).toBe(1);
    const closed = new Promise<void>((r) => t.socket.once("close", () => r()));
    rig.policies.set("127.0.0.1", {
      sessionId: newId("ses") as never,
      connectionCap: 5,
    });
    await closed;
  });
});

describe("plain HTTP proxying", () => {
  function http(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ): Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const r = request(
        { host: "127.0.0.1", port: rig.port, method, path, headers },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
            }),
          );
        },
      );
      r.on("error", reject);
      r.end();
    });
  }

  it("forwards to the checked address with the right Host, and strips hop-by-hop headers", async () => {
    rig = await makeRig();
    const r = await http("http://public.test/a/b?x=1", {
      host: "public.test",
      "proxy-authorization": "secret",
      "x-keep": "1",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello /a/b?x=1");
    expect(r.headers["x-upstream"]).toBe("yes");
    expect(r.headers.connection).toBe("close");
    expect(rig.dialed).toEqual([{ ip: PUBLIC, port: 80 }]);
    const up = rig.seen[0]!;
    expect(up.headers.host).toBe("public.test");
    expect(up.headers["proxy-authorization"]).toBeUndefined();
    expect(up.headers["x-keep"]).toBe("1");
  });

  it("refuses internal targets with a 403 that says why", async () => {
    rig = await makeRig();
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:80/",
      "http://2130706433/",
      "http://[::1]/",
    ]) {
      const r = await http(u, { host: new URL(u).host });
      expect([400, 403], u).toContain(r.status);
      expect(r.headers["x-kestrel-egress-denied"], u).toBe("blocked_address");
    }
    expect(rig.dialed).toEqual([]);
  });

  it("refuses a Host header that disagrees with the request line, credentials, origin-form and https", async () => {
    rig = await makeRig();
    expect(
      (await http("http://public.test/", { host: "169.254.169.254" })).status,
    ).toBe(400);
    expect(
      (
        await http("http://user:pw@public.test/", {
          host: "user:pw@public.test",
        })
      ).status,
    ).toBe(400);
    expect((await http("/just/a/path", { host: "public.test" })).status).toBe(
      400,
    );
    expect(
      (await http("https://public.test/", { host: "public.test" })).status,
    ).toBe(400);
    expect(rig.dialed).toEqual([]);
  });

  it("refuses a request with both Content-Length and Transfer-Encoding", async () => {
    rig = await makeRig();
    const res = await new Promise<string>((resolve) => {
      const s = connect({ host: "127.0.0.1", port: rig.port });
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
      s.write(
        "POST http://public.test/ HTTP/1.1\r\nHost: public.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      );
    });
    expect(res).toMatch(/^HTTP\/1\.1 400/);
    expect(rig.dialed).toEqual([]);
  });

  it("applies the same lists, ports and policy checks as CONNECT", async () => {
    rig = await makeRig();
    expect(
      (await http("http://public.test:8080/", { host: "public.test:8080" }))
        .headers["x-kestrel-egress-denied"],
    ).toBe("port_not_allowed");
    rig.policies.delete("127.0.0.1");
    expect(
      (await http("http://public.test/", { host: "public.test" })).headers[
        "x-kestrel-egress-denied"
      ],
    ).toBe("no_policy");
  });
});

describe("upstream trouble", () => {
  it("answers 502 when the destination refuses the connection", async () => {
    rig = await makeRig();
    // A connector whose target is closed.
    const dead = createTcp();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const p2 = new EgressProxy({
      policies: rig.policies,
      resolver: rig.resolver,
      denials: rig.denials,
      metrics: createEgressMetrics(),
      log: createLogger("t", "silent"),
      connect: () => connect({ host: "127.0.0.1", port }),
    });
    const pp = await p2.listen("127.0.0.1", 0);
    const t = await tunnel("public.test:443", pp);
    expect(t.status).toBe(502);
    t.socket.destroy();
    await p2.close();
  });

  it("closes an idle tunnel", async () => {
    rig = await makeRig({ idleTimeoutMs: 150 });
    const t = await tunnel("public.test:443", rig.port);
    const closed = new Promise<void>((r) => t.socket.once("close", () => r()));
    await closed;
  });
});

describe("denial events (N14)", () => {
  it("are reported at once, then aggregated per window", async () => {
    let now = 1_000_000;
    const log = new DenialLog(() => now, 10_000);
    const d = {
      sessionId: SESSION,
      host: "169.254.169.254",
      port: 80,
      reason: "blocked_address" as const,
    };
    for (let i = 0; i < 50; i++) log.add(d);
    let got = log.read(0);
    expect(got.map((e) => e.count)).toEqual([1]);
    now += 10_001;
    got = log.read(0);
    expect(got.map((e) => e.count)).toEqual([1, 49]);
    expect(log.read(got[1]!.seq)).toEqual([]);
    log.add({ ...d, host: "other.test" });
    expect(log.read(got[1]!.seq)).toHaveLength(1);
  });

  it("go to a session's timeline, and a stranger's go only to metrics", async () => {
    rig = await makeRig();
    await deniedWith("169.254.169.254:80", "blocked_address");
    expect(rig.denials.read(0)).toMatchObject([
      {
        sessionId: SESSION,
        host: "169.254.169.254",
        port: 80,
        reason: "blocked_address",
        count: 1,
      },
    ]);
    rig.policies.delete("127.0.0.1");
    await deniedWith("169.254.169.254:80", "no_policy");
    expect(rig.denials.read(0)).toHaveLength(1);
  });
});
