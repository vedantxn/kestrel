import { mkdtempSync, statSync } from "node:fs";
import {
  connect,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ControlServer } from "./control.js";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";
import { EgressProxy } from "./proxy.js";
import type { Resolver } from "./resolver.js";

const SESSION = newId("ses");
const PUBLIC = "93.184.216.34";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowResolver implements Resolver {
  delayMs = 0;
  async resolve4(name: string) {
    if (this.delayMs) await wait(this.delayMs);
    return name.endsWith(".test") ? [PUBLIC] : [];
  }
}

interface Rig {
  proxy: EgressProxy;
  port: number;
  policies: PolicyStore;
  resolver: SlowResolver;
  denials: DenialLog;
  dialed: number;
  /** What every checked destination answers, as raw bytes. */
  upstream: { reply: (socket: Socket, request: string) => void };
  open(): Promise<number>;
  close(): Promise<void>;
}

let rig: Rig;
afterEach(async () => rig?.close());

async function makeRig(
  opts: {
    cap?: number;
    preRequestTimeoutMs?: number;
    idleTimeoutMs?: number;
  } = {},
): Promise<Rig> {
  const policies = new PolicyStore();
  policies.set("127.0.0.1", {
    sessionId: SESSION as never,
    connectionCap: opts.cap ?? 256,
  });
  const resolver = new SlowResolver();
  const denials = new DenialLog();
  const upstream: Rig["upstream"] = {
    reply: (s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"),
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    s.once("data", (d) => upstream.reply(s, d.toString()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const serverPort = (server.address() as AddressInfo).port;
  let dialed = 0;
  const proxy = new EgressProxy({
    policies,
    resolver,
    denials,
    metrics: createEgressMetrics(),
    log: createLogger("t", "silent"),
    connectTimeoutMs: 2000,
    ...(opts.preRequestTimeoutMs
      ? { preRequestTimeoutMs: opts.preRequestTimeoutMs }
      : {}),
    ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    connect: () => {
      dialed++;
      return connect({ host: "127.0.0.1", port: serverPort });
    },
  });
  const port = await proxy.listen("127.0.0.1", 0);
  const r: Rig = {
    proxy,
    port,
    policies,
    resolver,
    denials,
    upstream,
    get dialed() {
      return dialed;
    },
    open: () =>
      new Promise((resolve) =>
        (proxy as unknown as { http: Server }).http.getConnections((_e, n) =>
          resolve(n),
        ),
      ),
    close: async () => {
      await proxy.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
  } as Rig;
  return r;
}

/** Send raw bytes and collect everything until the proxy closes the socket (or `ms` passes). */
function raw(
  port: number,
  bytes: string,
  ms = 1500,
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    let text = "";
    let closed = false;
    s.on("data", (d) => (text += d.toString("latin1")));
    s.on("close", () => {
      closed = true;
      resolve({ text, closed });
    });
    s.on("error", () => undefined);
    s.write(bytes);
    setTimeout(() => {
      s.destroy();
      resolve({ text, closed });
    }, ms);
  });
}
const getReq = (extra = "") =>
  `GET http://public.test/x HTTP/1.1\r\nHost: public.test\r\n${extra}\r\n`;
const status = (t: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(t)?.[1]);

describe("a hostile destination cannot hurt the gateway", () => {
  for (const [name, reply] of [
    ["status 099", "HTTP/1.1 099 X\r\ncontent-length: 0\r\n\r\n"],
    ["status 000", "HTTP/1.1 000 X\r\ncontent-length: 0\r\n\r\n"],
    [
      "101 switching protocols",
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    ],
    ["status 999", "HTTP/1.1 999 X\r\ncontent-length: 0\r\n\r\n"],
  ] as const) {
    it(`survives ${name}, answers 502, and keeps serving`, async () => {
      rig = await makeRig({ cap: 3 });
      rig.upstream.reply = (s) => s.end(reply);
      const r = await raw(rig.port, getReq());
      expect(status(r.text), name).toBe(502);
      expect(r.closed).toBe(true);
      expect(rig.policies.get("127.0.0.1")?.active).toBe(0);
      // and the proxy still works
      rig.upstream.reply = (s) =>
        s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      expect(status((await raw(rig.port, getReq())).text)).toBe(200);
    });
  }

  it("a destination that truncates its body does not hold a slot", async () => {
    rig = await makeRig({ cap: 3 });
    rig.upstream.reply = (s) => {
      s.write("HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\npartial");
      setTimeout(() => s.destroy(), 20);
    };
    const r = await raw(rig.port, getReq());
    expect(r.closed).toBe(true);
    await wait(50);
    expect(rig.policies.get("127.0.0.1")?.active).toBe(0);
  });
});

describe("the connection cap counts requests in flight (N11)", () => {
  it("holds exactly the cap when many CONNECTs arrive at once, even while resolving", async () => {
    rig = await makeRig({ cap: 5 });
    rig.resolver.delayMs = 100;
    const results = await Promise.all(
      Array.from(
        { length: 60 },
        () =>
          new Promise<number>((resolve) => {
            const s = connect({ host: "127.0.0.1", port: rig.port });
            let buf = "";
            s.on("data", (d) => {
              buf += d.toString();
              if (buf.includes("\r\n\r\n")) resolve(status(buf));
            });
            s.on("error", () => resolve(0));
            s.write(
              "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
            );
            setTimeout(() => resolve(-1), 3000);
          }),
      ),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(5);
    expect(results.filter((s) => s === 503)).toHaveLength(55);
    expect(rig.policies.get("127.0.0.1")?.active).toBe(5);
  });

  it("gives the slot back when a tunnel closes, and when a dial fails", async () => {
    rig = await makeRig({ cap: 1 });
    const s = connect({ host: "127.0.0.1", port: rig.port });
    await new Promise<void>((r) => {
      s.once("data", () => r());
      s.write(
        "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
      );
    });
    expect(rig.policies.get("127.0.0.1")?.active).toBe(1);
    s.destroy();
    await wait(80);
    expect(rig.policies.get("127.0.0.1")?.active).toBe(0);
    // a failing dial
    const failing = new EgressProxy({
      policies: rig.policies,
      resolver: rig.resolver,
      denials: rig.denials,
      metrics: createEgressMetrics(),
      log: createLogger("t", "silent"),
      connect: () => connect({ host: "127.0.0.1", port: 1 }),
    });
    const p = await failing.listen("127.0.0.1", 0);
    expect(
      status(
        (
          await raw(
            p,
            "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
          )
        ).text,
      ),
    ).toBe(502);
    expect(rig.policies.get("127.0.0.1")?.active).toBe(0);
    await failing.close();
  });

  it("serves one request per connection, so pipelining cannot multiply dials past the cap", async () => {
    rig = await makeRig({ cap: 3 });
    const r = await raw(rig.port, getReq().repeat(10));
    expect(r.closed).toBe(true);
    expect(rig.dialed).toBe(1);
    expect((r.text.match(/^HTTP\/1\.1 /gm) ?? []).length).toBe(1);
  });
});

describe("sockets are not leaked", () => {
  it("a refused CONNECT is closed by the proxy even if the client never closes", async () => {
    rig = await makeRig();
    const socks: Socket[] = [];
    for (let i = 0; i < 40; i++) {
      const s = connect({ host: "127.0.0.1", port: rig.port });
      s.on("error", () => undefined);
      s.write(
        "CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n",
      );
      socks.push(s);
    }
    await wait(300);
    expect(await rig.open()).toBe(0);
    socks.forEach((s) => s.destroy());
  });

  it("a malformed request is answered and closed", async () => {
    rig = await makeRig();
    const socks: Socket[] = [];
    for (let i = 0; i < 20; i++) {
      const s = connect({ host: "127.0.0.1", port: rig.port });
      s.on("error", () => undefined);
      s.write("FOO / HTTP/9\r\n\r\n");
      socks.push(s);
    }
    await wait(300);
    expect(await rig.open()).toBe(0);
    socks.forEach((s) => s.destroy());
  });

  it("drops connections that never finish a request, or never send one", async () => {
    rig = await makeRig({ preRequestTimeoutMs: 150 });
    const socks: Socket[] = [];
    for (let i = 0; i < 30; i++) {
      const s = connect({ host: "127.0.0.1", port: rig.port });
      s.on("error", () => undefined);
      if (i % 2)
        s.write(
          "GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nx-slow: ",
        ); // headers never end
      socks.push(s);
    }
    await wait(200);
    expect(await rig.open()).toBeGreaterThan(0);
    await wait(1500);
    expect(await rig.open()).toBe(0);
    socks.forEach((s) => s.destroy());
  });
});

describe("request smuggling (framing)", () => {
  const smuggle =
    "3a\r\nGET /smuggled HTTP/1.1\r\nHost: evil.example\r\n\r\n\r\n0\r\n\r\n";

  it("refuses a body on a method that has none", async () => {
    rig = await makeRig();
    for (const m of ["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"]) {
      const chunked = `${m} http://public.test/x HTTP/1.1\r\nHost: public.test\r\nTransfer-Encoding: chunked\r\n\r\n${smuggle}`;
      expect(status((await raw(rig.port, chunked)).text), m).toBe(400);
      const sized = `${m} http://public.test/x HTTP/1.1\r\nHost: public.test\r\nContent-Length: 4\r\n\r\nabcd`;
      expect(status((await raw(rig.port, sized)).text), m).toBe(400);
    }
    expect(rig.dialed).toBe(0);
  });

  it("still relays a real POST body", async () => {
    rig = await makeRig();
    let got = "";
    rig.upstream.reply = (s, req) => {
      got = req;
      s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
    };
    const r = await raw(
      rig.port,
      "POST http://public.test/x HTTP/1.1\r\nHost: public.test\r\nContent-Length: 5\r\n\r\nhello",
    );
    expect(status(r.text)).toBe(200);
    await wait(20);
    expect(got).toContain("hello");
  });
});

describe("the policy is checked again after every wait", () => {
  it("a decision made under a policy that was replaced while resolving is refused", async () => {
    rig = await makeRig();
    rig.resolver.delayMs = 150;
    const pending = raw(
      rig.port,
      "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
    );
    await wait(40);
    rig.policies.delete("127.0.0.1");
    rig.policies.set("127.0.0.1", {
      sessionId: newId("ses") as never,
      connectionCap: 5,
    });
    const r = await pending;
    expect(status(r.text)).toBe(403);
    expect(rig.dialed).toBe(0);
    expect(rig.policies.get("127.0.0.1")?.active).toBe(0);
  });

  it("limits how many names are resolved at once across all sessions", async () => {
    rig = await makeRig();
    rig.resolver.delayMs = 300;
    const results = await Promise.all(
      Array.from({ length: 90 }, (_, i) =>
        raw(
          rig.port,
          `CONNECT h${i}.test:443 HTTP/1.1\r\nHost: h${i}.test:443\r\n\r\n`,
          1200,
        ).then((r) => status(r.text)),
      ),
    );
    expect(results.filter((s) => s === 503).length).toBeGreaterThanOrEqual(20);
    expect(results.filter((s) => s === 200).length).toBeGreaterThanOrEqual(60);
  });
});

describe("the denial log cannot be flooded (N14)", () => {
  it("one session's unique hosts do not evict another's events or slow the log", () => {
    let now = 1_000_000;
    const log = new DenialLog(() => now, 10_000, 1000);
    const victim = newId("ses");
    log.add({
      sessionId: victim,
      host: "169.254.169.254",
      port: 80,
      reason: "blocked_address",
    });
    const attacker = newId("ses");
    const t0 = Date.now();
    for (let i = 0; i < 30_000; i++)
      log.add({
        sessionId: attacker,
        host: `h${i}.x.test`,
        port: 443,
        reason: "blocked_address",
      });
    expect(Date.now() - t0).toBeLessThan(400);
    const all = log.read(0);
    expect(
      all.some((e) => e.sessionId === victim && e.host === "169.254.169.254"),
    ).toBe(true);
    const mine = all.filter((e) => e.sessionId === attacker);
    expect(mine.length).toBeLessThanOrEqual(21); // 20 distinct, plus one summary
    now += 10_001;
    const later = log
      .read(0)
      .filter((e) => e.sessionId === attacker && e.host === "*");
    expect(later.reduce((n, e) => n + e.count, 0)).toBeGreaterThan(29_000);
  });
});

describe("the control socket is private from the first moment", () => {
  it("is created owner-only, and leaves the process umask as it found it", async () => {
    const before = process.umask();
    const path = join(mkdtempSync(join(tmpdir(), "egress-")), "egress.sock");
    const server = new ControlServer(
      new PolicyStore(),
      new DenialLog(),
      createEgressMetrics(),
      createLogger("t", "silent"),
    );
    await server.listen(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(process.umask()).toBe(before);
    await server.close();
  });
});
