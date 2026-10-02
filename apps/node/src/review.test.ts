import { createServer } from "node:http";
import { connect } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import * as selfsigned from "selfsigned";
import { describe, expect, it } from "vitest";
import { copyCertificate, findCaddyPair } from "./cert-copy.js";
import { GatewayHub } from "./gateway-hub.js";
import { HttpRuntimeClient } from "./runtime-client.js";
import { Store } from "./store.js";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("starts and the pool", () => {
  it("a slow cold start is not judged a stray container by reconciliation", async () => {
    const r = makeRig({ poolTarget: 0, readyTimeoutMs: 120_000 });
    await bootWithPool(r);
    const orig = r.docker.run.bind(r.docker);
    r.docker.run = async (spec) => {
      const info = await orig(spec);
      r.runtime.neverReady.add(info.address!); // Chrome is slow to come up
      return info;
    };
    const req = startReq();
    const starting = r.agent.start(req);
    await wait(50);
    r.clock.advance(40_000); // well past the 15 s grace a stray container gets
    await r.agent.reconcile();
    expect(r.docker.containers.size).toBe(1); // still there
    r.runtime.neverReady.clear();
    expect((await starting).result).toBe("ready");
    expect(r.docker.containers.size).toBe(1);
  });

  it("two starts running together never share a container", async () => {
    const r = makeRig({ poolTarget: 2 });
    await bootWithPool(r);
    const [p1] = r.store.allPool();
    r.docker.kill(p1!.containerId); // a dead pooled browser nobody has noticed yet
    const a = startReq();
    const b = startReq();
    const [ra, rb] = await Promise.all([r.agent.start(a), r.agent.start(b)]);
    expect(ra.result).toBe("ready");
    expect(rb.result).toBe("ready");
    const ca = r.store.getBinding(a.sessionId)!.containerId;
    const cb = r.store.getBinding(b.sessionId)!.containerId;
    expect(ca).not.toBe(cb);
    expect(r.store.getBinding(a.sessionId)!.address).not.toBe(
      r.store.getBinding(b.sessionId)!.address,
    );
  });

  it("a pool container is taken by exactly one caller", async () => {
    const r = makeRig();
    await bootWithPool(r);
    const [p] = r.store.allPool();
    expect(r.store.takePool(p!.containerId)).toBe(true);
    expect(r.store.takePool(p!.containerId)).toBe(false);
  });

  it("a stop during the cold create leaves no container behind", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const orig = r.docker.run.bind(r.docker);
    let release!: () => void;
    r.docker.run = async (spec) => {
      await new Promise<void>((res) => (release = res));
      return orig(spec);
    };
    const req = startReq();
    const starting = r.agent.start(req);
    await wait(30);
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    release();
    expect((await starting).result).toBe("failed");
    await r.agent.idle();
    expect(r.docker.containers.size).toBe(0);
    expect(r.egress.policies.size).toBe(0);
  });

  it("boot removes a pooled browser a crash left starting", async () => {
    const r = makeRig({ poolTarget: 0 });
    await r.agent.boot();
    const id = r.docker.plant(
      { "kestrel.node": "a", "kestrel.role": "pool" },
      5_000,
    );
    r.store.upsertPool({
      containerId: id,
      address: "172.30.1.50",
      controlToken: "t",
      state: "starting",
      createdAt: 0,
    });
    r.restart();
    await r.agent.boot();
    expect(r.store.allPool()).toEqual([]);
    expect(r.docker.containers.has(id)).toBe(false);
  });
});

describe("attachments and boot", () => {
  it("a gateway that said hello before boot finished keeps its session from idling out", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 10_000 });
    await r.agent.start(req);
    r.restart();
    // the gateway reconnects and says hello while boot has not run yet
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    await r.agent.boot();
    expect(r.store.getBinding(req.sessionId)).toMatchObject({
      attached: 1,
      idleAt: null,
    });
    r.clock.advance(120_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("ready");
  });
});

describe("teardown that fails", () => {
  it("is retried, not forgotten, when Docker will not remove the container", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 5_000 });
    await r.agent.start(req);
    const orig = r.docker.remove.bind(r.docker);
    let fails = 1;
    r.docker.remove = async (id) => {
      if (fails-- > 0) throw new Error("docker: device busy");
      return orig(id);
    };
    r.clock.advance(6_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("stopping"); // stuck for now
    r.clock.advance(6_000);
    r.agent.tick(); // the retry
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    expect(r.docker.containers.size).toBe(0);
    expect(
      r.store.pendingReports().filter((x) => x.kind === "removed"),
    ).toHaveLength(1);
  });

  it("keeps the container when the egress gateway is up but will not clear the policy, and proceeds when it is down", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const cid = r.store.getBinding(req.sessionId)!.containerId!;
    const clear = r.egress.clearPolicy.bind(r.egress);
    r.egress.clearPolicy = async () => {
      throw new Error("egress: 500"); // up (health answers), but refusing
    };
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(r.docker.containers.has(cid)).toBe(true); // not removed while its policy stands
    expect(r.store.getBinding(req.sessionId)?.state).toBe("stopping");
    // now the egress gateway is entirely down: it holds nothing, so removal is safe
    r.egress.down = true;
    r.clock.advance(6_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.docker.containers.has(cid)).toBe(false);
    r.egress.clearPolicy = clear;
  });
});

describe("reconciliation does not trust a stale listing", () => {
  it("re-inspects before declaring a session's container gone", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    r.docker.list = async () => []; // an old snapshot, from before the container existed
    await r.agent.reconcile();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("ready");
    expect(r.store.pendingReports()).toEqual([]);
  });
});

describe("the API's replies", () => {
  it("an epoch never goes back", async () => {
    const r = makeRig();
    r.store.epoch = 5;
    r.api.epoch = 3;
    await r.agent.heartbeat();
    expect(r.store.epoch).toBe(5);
    r.api.epoch = 6;
    await r.agent.heartbeat();
    expect(r.store.epoch).toBe(6);
  });
});

describe("reports", () => {
  it("drop events beyond a cap, but never a removal, and drain several batches at once", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    for (let i = 0; i < 3000; i++)
      r.agent.handleAttachments("g1", [
        { sessionId: req.sessionId, connections: 1 + (i % 2) },
      ]);
    expect(r.store.pendingReportCount()).toBeLessThanOrEqual(
      Store.MAX_PENDING_EVENTS,
    );
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(
      r.store.pendingReports(10_000).some((x) => x.kind === "removed"),
    ).toBe(true);
    await r.agent.flushReports();
    expect(r.api.allReports.length).toBeGreaterThan(300); // more than one batch of 100 per call
  });

  it("queues the removal in the same transaction that deletes the binding", () => {
    const store = new Store(":memory:");
    store.insertBinding({
      sessionId: "ses_x",
      projectId: "prj_x",
      state: "stopping",
      containerId: null,
      address: null,
      proof: null,
      controlToken: null,
      policy: {},
      viewport: { width: 1, height: 1 },
      stopOnDisconnect: false,
      timeoutMs: 1,
      idleTimeoutMs: 1,
      createdAt: 0,
      readyAt: null,
      maxAt: 1,
      idleAt: null,
      attached: 0,
      stopReason: "client_stop",
      startPath: null,
    });
    store.finishBinding("ses_x", (id) => ({
      id,
      at: new Date().toISOString(),
      kind: "removed",
      sessionId: "ses_x" as never,
      endReason: "client_stop",
      browserSeconds: 0,
    }));
    expect(store.getBinding("ses_x")).toBeUndefined();
    expect(store.pendingReportCount()).toBe(1);
  });

  it("the store file is private to its owner", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "store.db");
    const s = new Store(path);
    s.epoch = 1;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    s.close();
  });
});

describe("the gateway hub (G12, G-10)", () => {
  async function hub() {
    const dir = mkdtempSync(join(tmpdir(), "hub-"));
    const path = join(dir, "agent.sock");
    const gone: string[] = [];
    const seen: [string, number][] = [];
    const h = new GatewayHub({
      log: createLogger("t", "silent"),
      routes: () => [],
      onAttachments: (g, a) => seen.push([g, a.length]),
      onGone: (g) => gone.push(g),
    });
    await h.listen(path);
    const client = () => {
      const s = connect(path);
      s.on("error", () => undefined);
      s.resume(); // read, so the close of the other end is seen
      return {
        s,
        send: (m: unknown) => s.write(encodeLine(m)),
        closed: new Promise<void>((r) => s.once("close", () => r())),
      };
    };
    return { h, client, gone, seen };
  }
  const hello = (id: string) => ({
    type: "hello",
    protocolVersion: 1,
    gatewayId: id,
    attachments: [],
  });

  it("a restarted gateway reusing its id supersedes the old connection without wiping its own attachments", async () => {
    const { h, client, gone } = await hub();
    const old = client();
    old.send(hello("gw"));
    await wait(40);
    const fresh = client();
    fresh.send(hello("gw"));
    await wait(80);
    await old.closed;
    await wait(40);
    expect(gone).toEqual([]); // the id is still live: the new connection holds it
    fresh.s.destroy();
    await wait(60);
    expect(gone).toEqual(["gw"]);
    await h.close();
  });

  it("a second hello on one connection cannot rename it", async () => {
    const { h, client } = await hub();
    const c = client();
    c.send(hello("a"));
    await wait(30);
    c.send(hello("b"));
    await c.closed;
    await h.close();
  });

  it("drops a peer that sends a huge frame with no newline, without buffering it", async () => {
    const { h, client } = await hub();
    const c = client();
    c.send(hello("a"));
    await wait(30);
    c.s.write("x".repeat(3 * 1024 * 1024));
    await c.closed;
    await h.close();
  });
});

describe("the runtime client (G-18)", () => {
  it("does not follow a redirect to another address", async () => {
    let hits = 0;
    const target = createServer((_q, res) => {
      hits++;
      res.end("{}");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as { port: number }).port;
    const redirector = createServer((_q, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${tport}/steal` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const rport = (redirector.address() as { port: number }).port;
    await expect(
      new HttpRuntimeClient(rport).health("127.0.0.1", "t"),
    ).rejects.toThrow();
    expect(hits).toBe(0);
    redirector.close();
    target.close();
  });
});

describe("certificate copy (G-08)", () => {
  const make = (cn: string) =>
    selfsigned.generate([{ name: "commonName", value: cn }], {
      keySize: 2048,
      algorithm: "sha256",
    });

  it("refuses a hostname that is not an ordinary hostname", () => {
    const root = mkdtempSync(join(tmpdir(), "caddy-"));
    for (const bad of [
      "../x",
      "a/b",
      "..",
      "a..b",
      "",
      "-a.com",
      "a b",
      "a\u0000b",
    ])
      expect(findCaddyPair(root, bad), bad).toBeNull();
  });

  it("does not follow a symlinked issuer directory out of Caddy's tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "caddy-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    const pair = await make("h.example");
    mkdirSync(join(elsewhere, "h.example"), { recursive: true });
    writeFileSync(join(elsewhere, "h.example", "h.example.crt"), pair.cert);
    writeFileSync(join(elsewhere, "h.example", "h.example.key"), pair.private);
    mkdirSync(join(root, "caddy", "certificates"), { recursive: true });
    symlinkSync(elsewhere, join(root, "caddy", "certificates", "evil-issuer"));
    expect(findCaddyPair(root, "h.example")).toBeNull();
  });

  it("does not throw when the destination cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "caddy-"));
    const pair = await make("h.example");
    const dir = join(root, "caddy", "certificates", "issuer", "h.example");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "h.example.crt"), pair.cert);
    writeFileSync(join(dir, "h.example.key"), pair.private);
    const blocker = join(mkdtempSync(join(tmpdir(), "blk-")), "file");
    writeFileSync(blocker, "x");
    // an output directory underneath a regular file: mkdir fails. The caller must be able to catch it.
    expect(() =>
      copyCertificate({
        caddyData: root,
        hostname: "h.example",
        outDir: join(blocker, "out"),
      }),
    ).toThrow();
  });
});
