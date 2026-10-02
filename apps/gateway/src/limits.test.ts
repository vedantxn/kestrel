import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { CLOSE_CODES, encodeLine, newId } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import * as selfsigned from "selfsigned";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient, RouteTable, watchRoutesFile } from "./routes.js";
import { TlsWatcher, readTlsDir } from "./tls.js";
import {
  closeOf,
  makeRig,
  nextMessage,
  opened,
  pause,
  type Rig,
} from "./test/harness.js";

let rig: Rig;
afterEach(async () => rig?.close());
const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });

describe("connection limits (C4)", () => {
  it("allows 8 connections to a session and closes the 9th with 4008", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const open: WebSocket[] = [];
    for (let i = 0; i < 8; i++) open.push(await opened(await rig.connect(s)));
    expect((await closeOf(await rig.connect(s))).code).toBe(
      CLOSE_CODES.limitExceeded,
    );
    open[0]!.close();
    await pause(100);
    open.push(await opened(await rig.connect(s)));
    for (const w of open) w.close();
  });

  it("counts connections per session, not across sessions", async () => {
    rig = await makeRig({ limits: { maxConnectionsPerSession: 1 } });
    const a = await rig.addSession();
    const b = await rig.addSession();
    const wa = await opened(await rig.connect(a));
    const wb = await opened(await rig.connect(b));
    expect((await closeOf(await rig.connect(a))).code).toBe(
      CLOSE_CODES.limitExceeded,
    );
    wa.close();
    wb.close();
  });

  it("drops a client that stops answering pings", async () => {
    rig = await makeRig({
      limits: { pingIntervalMs: 40, missedPingsBeforeDrop: 2 },
    });
    const s = await rig.addSession();
    const ws = await opened(
      await rig.connect(s, { wsOpts: { autoPong: false } }),
    );
    const t = Date.now();
    await closeOf(ws);
    expect(Date.now() - t).toBeLessThan(1500);
    await pause(50);
    expect(rig.gateway.connectionCount()).toBe(0);
  });

  it("keeps a client that answers pings, however idle", async () => {
    rig = await makeRig({
      limits: { pingIntervalMs: 40, missedPingsBeforeDrop: 2 },
    });
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    await pause(400);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe("backpressure and shared budget (C5, C6)", () => {
  it("closes a client whose container stops reading with 4009, without touching another session", async () => {
    rig = await makeRig({
      limits: {
        pauseAtBufferedBytes: 256 * 1024,
        resumeAtBufferedBytes: 64 * 1024,
        maxPausedMs: 400,
        pingIntervalMs: 60_000,
      },
    });
    const slow = await rig.addSession();
    const fine = await rig.addSession();
    slow.container.mode = "stall";
    const ws = await opened(await rig.connect(slow));
    const neighbour = await opened(await rig.connect(fine));
    const chunk = "x".repeat(512 * 1024);
    const closed = closeOf(ws);
    const pump = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    }, 5);
    const r = await closed;
    clearInterval(pump);
    expect(r.code).toBe(CLOSE_CODES.tooSlow);
    neighbour.send(rpc(1, "Neighbour"));
    expect(JSON.parse(await nextMessage(neighbour)).id).toBe(1);
    neighbour.close();
  });

  it("resumes a paused side once the other drains, losing nothing", async () => {
    rig = await makeRig({
      limits: {
        pauseAtBufferedBytes: 128 * 1024,
        resumeAtBufferedBytes: 32 * 1024,
        maxPausedMs: 5000,
      },
    });
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    let replies = 0;
    ws.on("message", () => replies++);
    const n = 200;
    for (let i = 0; i < n; i++)
      ws.send(rpc(i, "Bulk", { pad: "y".repeat(64 * 1024) }));
    const until = Date.now() + 5000;
    while (replies < n && Date.now() < until) await pause(20);
    expect(replies).toBe(n);
    ws.close();
  });

  it("closes the connection that would exceed the global budget (4008), and only that one", async () => {
    rig = await makeRig({
      limits: {
        globalBufferBudgetBytes: 1024 * 1024,
        pauseAtBufferedBytes: 64 * 1024 * 1024,
      },
    });
    const hog = await rig.addSession();
    const calm = await rig.addSession();
    hog.container.mode = "stall";
    const wh = await opened(await rig.connect(hog));
    const wc = await opened(await rig.connect(calm));
    const closed = closeOf(wh);
    const chunk = "z".repeat(400 * 1024);
    const pump = setInterval(
      () => wh.readyState === WebSocket.OPEN && wh.send(chunk),
      5,
    );
    expect((await closed).code).toBe(CLOSE_CODES.limitExceeded);
    clearInterval(pump);
    wc.send(rpc(2, "Calm"));
    expect(JSON.parse(await nextMessage(wc)).id).toBe(2);
    await pause(100);
    expect(rig.gateway.budget.usedBytes).toBe(0);
    wc.close();
  });
});

describe("attachments, revocation and expiry (G12)", () => {
  it("reports attachment snapshots as connections come and go", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const a = await opened(await rig.connect(s));
    const b = await opened(await rig.connect(s));
    await pause(20);
    expect(rig.attachments.at(-1)).toEqual([
      { sessionId: s.id, connections: 2 },
    ]);
    a.close();
    await pause(100);
    expect(rig.attachments.at(-1)).toEqual([
      { sessionId: s.id, connections: 1 },
    ]);
    b.close();
    await pause(100);
    expect(rig.attachments.at(-1)).toEqual([]);
  });

  it("closes a session's connections with 4002 the moment its route is removed", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const other = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    const keep = await opened(await rig.connect(other));
    rig.table.remove(s.id);
    expect((await closeOf(ws)).code).toBe(CLOSE_CODES.sessionEnded);
    expect(keep.readyState).toBe(WebSocket.OPEN);
    keep.close();
  });

  it("closes connections whose route has passed its time, without hearing from the agent", async () => {
    rig = await makeRig({ routeExpirySweepMs: 30 });
    const s = await rig.addSession({ notAfterSec: 5 });
    const ws = await opened(await rig.connect(s));
    rig.clock.advance(6_000);
    expect((await closeOf(ws)).code).toBe(CLOSE_CODES.sessionEnded);
  });

  it("a replaced route table closes what is no longer in it", async () => {
    rig = await makeRig();
    const a = await rig.addSession();
    const b = await rig.addSession();
    const wa = await opened(await rig.connect(a));
    const wb = await opened(await rig.connect(b));
    rig.table.replaceAll([rig.table.get(b.id)!]);
    expect((await closeOf(wa)).code).toBe(CLOSE_CODES.sessionEnded);
    expect(wb.readyState).toBe(WebSocket.OPEN);
    wb.close();
  });
});

describe("shutdown and pre-authentication limits (W4, G-13)", () => {
  it("drains: refuses new connections, lets existing ones finish, then says 1012", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    const stopping = rig.gateway.stop(400);
    await pause(50);
    ws.send(rpc(1, "During.drain"));
    expect(JSON.parse(await nextMessage(ws)).id).toBe(1);
    const late = await rig.connect(s).catch(() => null);
    if (late) await closeOf(late).catch(() => undefined);
    const r = await closeOf(ws);
    await stopping;
    expect(r.code).toBe(CLOSE_CODES.gatewayRestarting);
  });

  it("finishes as soon as the last connection goes if that is before the drain limit", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    const t = Date.now();
    const stopping = rig.gateway.stop(5000);
    await pause(100);
    ws.close();
    await stopping;
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("rate-limits an address that keeps presenting bad tokens", async () => {
    rig = await makeRig({ authFailuresPerMinute: 5 });
    const s = await rig.addSession();
    for (let i = 0; i < 5; i++)
      expect(
        (await rig.http(`/v1/sessions/${s.id}/cdp/json/version?token=bad`))
          .status,
      ).toBe(401);
    expect(
      (await rig.http(`/v1/sessions/${s.id}/cdp/json/version?token=bad`))
        .status,
    ).toBe(429);
    // even a good token is refused while the address is blocked
    expect(
      (
        await rig.http(
          `/v1/sessions/${s.id}/cdp/json/version?token=${await rig.token(s)}`,
        )
      ).status,
    ).toBe(429);
    expect((await rig.http("/healthz")).status).toBe(200);
  });

  it("rejects an oversized header block", async () => {
    rig = await makeRig();
    const res = await fetch(`http://${rig.host}/healthz`, {
      headers: { "x-pad": "a".repeat(20_000) },
    }).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
  });
});

describe("TLS (W2, G16)", () => {
  const cert = async (cn: string) =>
    selfsigned.generate([{ name: "commonName", value: cn }], {
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
          ],
        },
      ],
    });

  const peerCn = (port: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const s = tlsConnect(
        {
          host: "127.0.0.1",
          port,
          rejectUnauthorized: false,
          servername: "localhost",
        },
        () => {
          const subject = s.getPeerCertificate().subject;
          s.end();
          resolve(subject.CN as string);
        },
      );
      s.on("error", reject);
    });

  it("serves over TLS and swaps in a renewed certificate without a restart", async () => {
    const one = await cert("first");
    const two = await cert("second");
    rig = await makeRig({ tls: { cert: one.cert, key: one.private } });
    expect(await peerCn(rig.port)).toBe("first");
    rig.gateway.setTls({ cert: two.cert, key: two.private });
    expect(await peerCn(rig.port)).toBe("second");
  });

  it("reads a certificate directory, and ignores a key that does not match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tls-"));
    const a = await cert("a");
    const b = await cert("b");
    expect(readTlsDir(dir)).toBeNull();
    writeFileSync(join(dir, "cert.pem"), a.cert);
    writeFileSync(join(dir, "key.pem"), b.private);
    expect(readTlsDir(dir)).toBeNull();
    writeFileSync(join(dir, "key.pem"), a.private);
    expect(readTlsDir(dir)?.cert).toBe(a.cert);
  });

  it("waits for a certificate to appear, then reloads on change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tls-"));
    const w = new TlsWatcher(dir, createLogger("t", "silent"), 40);
    const first = w.waitForFirst();
    await pause(150);
    const a = await cert("a");
    writeFileSync(join(dir, "key.pem"), a.private);
    writeFileSync(join(dir, "cert.pem"), a.cert);
    expect((await first).cert).toBe(a.cert);
    const seen: string[] = [];
    w.watch((m) => seen.push(m.cert));
    const b = await cert("b");
    await pause(30);
    writeFileSync(join(dir, "key.pem"), b.private);
    writeFileSync(join(dir, "cert.pem"), b.cert);
    const until = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < until) await pause(30);
    w.stop();
    expect(seen).toEqual([b.cert]);
  });
});

describe("the node agent socket and routes file (C6, G12)", () => {
  let agent: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (agent ? agent.close(() => r()) : r()));
    agent = undefined;
  });

  const route = (id: string) => ({
    sessionId: id,
    projectId: newId("prj"),
    address: "172.30.1.9",
    port: 9223,
    proof: "ab".repeat(32),
    notAfter: 4_000_000_000,
  });

  function fakeAgent(path: string) {
    const lines: unknown[] = [];
    const sockets = new Set<Socket>();
    agent = createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
    });
    agent.listen(path);
    return {
      lines,
      send: (m: unknown) => sockets.forEach((s) => s.write(encodeLine(m))),
      sendRaw: (t: string) => sockets.forEach((s) => s.write(t)),
      drop: () => sockets.forEach((s) => s.destroy()),
      count: () => sockets.size,
    };
  }

  it("says hello with its attachments, receives routes, and reports attachment changes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-")), "agent.sock");
    const fa = fakeAgent(path);
    const table = new RouteTable();
    const ses = newId("ses");
    const client = new AgentClient({
      socketPath: path,
      gatewayId: "g1",
      table,
      log: createLogger("t", "silent"),
      attachments: () => [{ sessionId: ses as never, connections: 2 }],
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
    });
    client.start();
    await pause(100);
    expect(fa.lines[0]).toEqual({
      type: "hello",
      protocolVersion: 1,
      gatewayId: "g1",
      attachments: [{ sessionId: ses, connections: 2 }],
    });

    const a = newId("ses");
    const b = newId("ses");
    fa.send({ type: "routes", routes: [route(a), route(b)] });
    await pause(50);
    expect(table.ids().sort()).toEqual([a, b].sort());
    fa.send({ type: "route.remove", sessionId: a });
    fa.sendRaw("garbage not json\n");
    fa.send({ type: "route.put", route: route(newId("ses")) });
    await pause(50);
    expect(table.size).toBe(2);
    expect(table.get(a)).toBeUndefined();

    client.sendAttachments([]);
    await pause(50);
    expect(fa.lines.at(-1)).toEqual({ type: "attachments", attachments: [] });
    client.stop();
  });

  it("keeps routing on the routes it has when the agent goes away, and reconnects with a fresh hello", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-")), "agent.sock");
    let fa = fakeAgent(path);
    const table = new RouteTable();
    const client = new AgentClient({
      socketPath: path,
      gatewayId: "g1",
      table,
      log: createLogger("t", "silent"),
      attachments: () => [],
      reconnectMinMs: 20,
      reconnectMaxMs: 60,
    });
    client.start();
    await pause(80);
    const a = newId("ses");
    fa.send({ type: "routes", routes: [route(a)] });
    await pause(50);

    fa.drop();
    await new Promise<void>((r) => agent!.close(() => r()));
    await pause(100);
    expect(client.connected).toBe(false);
    expect(table.get(a)).toBeDefined(); // the data plane survives the control plane

    fa = fakeAgent(path);
    await pause(300);
    expect(client.connected).toBe(true);
    expect(fa.lines[0]).toMatchObject({ type: "hello" });
    const b = newId("ses");
    fa.send({ type: "routes", routes: [route(b)] }); // the new snapshot is the truth
    await pause(50);
    expect(table.ids()).toEqual([b]);
    client.stop();
  });

  it("loads a static routes file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "routes-")), "routes.json");
    const a = newId("ses");
    writeFileSync(file, JSON.stringify([route(a)]));
    const table = new RouteTable();
    const stop = watchRoutesFile(file, table, createLogger("t", "silent"));
    expect(table.get(a)).toBeDefined();
    await pause(150); // let the watcher settle before changing the file
    const b = newId("ses");
    writeFileSync(file, JSON.stringify([route(b)]));
    const until = Date.now() + 2000;
    while (table.get(b) === undefined && Date.now() < until) await pause(30);
    stop();
    expect(table.ids()).toEqual([b]);
  });
});
