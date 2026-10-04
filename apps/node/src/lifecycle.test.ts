import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

describe("deadlines are absolute and enforced by the agent (G11)", () => {
  it("ends a session at its maximum lifetime", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ timeoutMs: 20_000 });
    await r.agent.start(req);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]); // attached, so only the lifetime applies
    r.clock.advance(19_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("ready");
    r.clock.advance(1_001);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    expect(
      r.store.pendingReports().find((x) => x.kind === "removed"),
    ).toMatchObject({ endReason: "max_lifetime" });
  });

  it("ends a never-connected session at its idle timeout, which starts when it is ready", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 5_000 });
    await r.agent.start(req);
    r.clock.advance(4_999);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)).toBeDefined();
    r.clock.advance(2);
    r.agent.tick();
    await r.agent.idle();
    expect(
      r.store.pendingReports().find((x) => x.kind === "removed"),
    ).toMatchObject({ endReason: "idle_timeout" });
  });

  it("an attached client holds off the idle timer; the last detach restarts it", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 5_000 });
    await r.agent.start(req);
    const id = req.sessionId as string;
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 2 },
    ]);
    expect(r.store.getBinding(id)).toMatchObject({ attached: 2, idleAt: null });
    r.clock.advance(60_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(id)?.state).toBe("ready");

    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    expect(r.store.getBinding(id)?.idleAt).toBeNull();
    r.agent.handleAttachments("g1", []);
    expect(r.store.getBinding(id)?.idleAt).toBe(r.clock.now() + 5_000);
    r.clock.advance(5_001);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(id)).toBeUndefined();
  });

  it("reports attach and detach to the API as events", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 2 },
    ]);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.agent.handleAttachments("g1", []);
    const types = r.store
      .pendingReports()
      .map((x) =>
        x.kind === "event"
          ? `${x.event.type}:${(x.event.data as { connections: number }).connections}`
          : x.kind,
      );
    expect(types).toEqual([
      "session.attached:1",
      "session.attached:2",
      "session.detached:1",
      "session.detached:0",
    ]);
  });

  it("counts two overlapping gateways, and a gateway that disconnects takes its attachments with it (G12)", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 5_000 });
    await r.agent.start(req);
    const id = req.sessionId as string;
    r.agent.handleAttachments("old", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.agent.handleAttachments("new", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    expect(r.store.getBinding(id)?.attached).toBe(2);
    r.agent.handleGatewayGone("old"); // a deploy retires the old gateway
    expect(r.store.getBinding(id)?.attached).toBe(1);
    r.agent.handleGatewayGone("new"); // a crash
    expect(r.store.getBinding(id)).toMatchObject({
      attached: 0,
      idleAt: r.clock.now() + 5_000,
    });
  });

  it("stopOnDisconnect ends the session when the last client leaves", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ stopOnDisconnect: true });
    await r.agent.start(req);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.agent.handleAttachments("g1", []);
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    expect(
      r.store.pendingReports().find((x) => x.kind === "removed"),
    ).toMatchObject({ endReason: "client_disconnect" });
  });
});

describe("reconciliation with Docker (G13)", () => {
  it("reports a session whose container died, and an OOM kill as oom", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const crashed = startReq();
    const oomed = startReq();
    await r.agent.start(crashed);
    await r.agent.start(oomed);
    r.docker.kill(r.store.getBinding(crashed.sessionId)!.containerId!, {
      exitCode: 139,
    });
    r.docker.kill(r.store.getBinding(oomed.sessionId)!.containerId!, {
      oom: true,
    });
    await r.agent.reconcile();
    await r.agent.idle();
    const reports = r.store.pendingReports();
    const removed = Object.fromEntries(
      reports
        .filter((x) => x.kind === "removed")
        .map((x) => [x.sessionId, x.endReason]),
    );
    expect(removed).toEqual({
      [crashed.sessionId]: "browser_crash",
      [oomed.sessionId]: "oom",
    });
    const crashEvent = reports.find(
      (x) =>
        x.kind === "event" &&
        x.event.type === "runtime.crashed" &&
        x.sessionId === crashed.sessionId,
    );
    expect(crashEvent).toMatchObject({
      event: { data: { process: "container", exitCode: 139 } },
    });
    expect(r.egress.policies.size).toBe(0);
    expect(r.docker.containers.size).toBe(0);
  });

  it("removes a container nothing refers to, but not one created a moment ago", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const old = r.docker.plant({ "kestrel.node": "a" }, 60_000);
    const young = r.docker.plant({ "kestrel.node": "a" }, 2_000);
    await r.agent.reconcile();
    expect(r.docker.containers.has(old)).toBe(false);
    expect(r.docker.containers.has(young)).toBe(true);
  });

  it("drops a pooled browser that died, and leaves running ones", async () => {
    const r = makeRig();
    await bootWithPool(r);
    const [a, b] = r.store.allPool();
    r.docker.kill(a!.containerId);
    await r.agent.reconcile();
    expect(r.store.allPool().map((p) => p.containerId)).toEqual([
      b!.containerId,
    ]);
    expect(r.docker.containers.has(a!.containerId)).toBe(false);
  });

  it("does not judge a session that is still starting", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    let release!: () => void;
    const orig = r.runtime.configure.bind(r.runtime);
    r.runtime.configure = async (a, t, q) => {
      await new Promise<void>((res) => (release = res));
      return orig(a, t, q);
    };
    const p = r.agent.start(req);
    await new Promise((res) => setTimeout(res, 50));
    await r.agent.reconcile();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("starting");
    release();
    expect((await p).result).toBe("ready");
  });
});

describe("the pool yields to sessions (G4, G5)", () => {
  it("fills only from slots no session is using, a few at a time", async () => {
    const r = makeRig({ slotsTotal: 3, poolTarget: 5, refillAtOnce: 1 });
    await r.agent.boot();
    await r.agent.refillPool();
    await r.agent.idle();
    expect(r.store.allPool()).toHaveLength(1); // refillAtOnce
    // refillAtOnce caps how many are in flight, so each fill finishes before the next begins.
    for (let i = 0; i < 3; i++) {
      await r.agent.refillPool();
      await r.agent.idle();
    }
    expect(r.store.allPool()).toHaveLength(3); // every slot is spare, so all three fill
    const req = startReq();
    await r.agent.start(req);
    await r.agent.refillPool();
    await r.agent.idle();
    expect(
      r.store.allPool().length + r.store.allBindings().length,
    ).toBeLessThanOrEqual(3);
  });

  it("gives a cold start the room when the pool is using every slot", async () => {
    const r = makeRig({ slotsTotal: 2, poolTarget: 2 });
    await bootWithPool(r);
    expect(r.store.allPool()).toHaveLength(2);
    const a = startReq();
    const b = startReq();
    expect((await r.agent.start(a)).result).toBe("ready");
    expect((await r.agent.start(b)).result).toBe("ready");
    await r.agent.idle();
    expect(r.docker.containers.size).toBeLessThanOrEqual(2);
  });

  it("makes no browsers while the firewall is unverified (G17)", async () => {
    const r = makeRig();
    r.firewall.ok = false;
    r.firewall.fixable = false;
    await r.agent.boot();
    await r.agent.refillPool();
    expect(r.docker.runCalls).toBe(0);
    expect(r.agent.admitting).toBe(false);
    r.firewall.fixable = true;
    await r.agent.checkFirewall();
    expect(r.firewall.ensured).toBeGreaterThan(1);
    expect(r.agent.admitting).toBe(true);
  });
});

describe("talking to the API (K7, G15)", () => {
  it("describes itself: slots, hot count, sessions, pending reports", async () => {
    const r = makeRig({ slotsTotal: 3 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    expect(r.agent.describe()).toMatchObject({
      nodeId: "a",
      epoch: 1,
      slots: { total: 3, free: 2 },
      hotCount: 2, // the taken browser's replacement is already warm
      sessions: [{ sessionId: req.sessionId, state: "ready" }],
      pendingReports: 0,
    });
  });

  it("stops what the reply says to stop, including sessions the API does not know, and adopts a new epoch", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const a = startReq();
    const b = startReq();
    await r.agent.start(a);
    await r.agent.start(b);
    r.api.epoch = 2;
    r.api.reply = {
      stop: [{ sessionId: a.sessionId, reason: "node_lost" }],
      unknown: [b.sessionId],
    };
    await r.agent.heartbeat();
    await r.agent.idle();
    expect(r.store.epoch).toBe(2);
    expect(r.store.allBindings()).toEqual([]);
    const reasons = r.store
      .pendingReports()
      .filter((x) => x.kind === "removed")
      .map((x) => x.endReason);
    expect(reasons.sort()).toEqual(["node_lost", "node_refused"]);
  });

  it("keeps reports until the API acknowledges them, in order, and survives the API being down", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.api.down = true;
    await r.agent.flushReports();
    await r.agent.heartbeat();
    expect(r.store.pendingReportCount()).toBe(1);
    r.api.down = false;
    await r.agent.flushReports();
    expect(r.store.pendingReportCount()).toBe(0);
    expect(r.api.allReports).toHaveLength(1);
    // a repeated delivery has the same id: the API treats it as one
    const ids = r.api.allReports.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers and takes the epoch it is given", async () => {
    const r = makeRig();
    r.api.epoch = 7;
    await r.agent.register();
    expect(r.store.epoch).toBe(7);
    expect(r.api.registered[0]).toMatchObject({ nodeId: "a", slotsTotal: 4 });
  });
});

describe("egress denials become events (N14)", () => {
  it("for live sessions only, and a restarted egress gateway restarts the cursor", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const at = new Date().toISOString();
    r.egress.denialList = [
      {
        seq: 1,
        sessionId: req.sessionId,
        host: "169.254.169.254",
        port: 80,
        reason: "blocked_address",
        count: 1,
        at,
      },
      {
        seq: 2,
        sessionId: startReq().sessionId,
        host: "x.test",
        port: 80,
        reason: "blocked_address",
        count: 1,
        at,
      },
    ];
    await r.agent.pollDenials();
    await r.agent.pollDenials();
    expect(
      r.store.pendingReports().filter((x) => x.kind === "event"),
    ).toHaveLength(1);
    r.egress.denialEpoch = "e2";
    r.egress.denialList = [
      {
        seq: 1,
        sessionId: req.sessionId,
        host: "10.0.0.1",
        port: 443,
        reason: "blocked_address",
        count: 3,
        at,
      },
    ];
    await r.agent.pollDenials();
    const evs = r.store.pendingReports().filter((x) => x.kind === "event");
    expect(evs).toHaveLength(2);
    expect(evs[1]).toMatchObject({
      event: { type: "egress.denied", data: { host: "10.0.0.1", count: 3 } },
    });
  });
});
