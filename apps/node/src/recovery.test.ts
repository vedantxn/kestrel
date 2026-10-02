import { FailpointError } from "@kestrel/shared";
import { describe, expect, it } from "vitest";
import { makeRig, bootWithPool, startReq, type Rig } from "./test/fakes.js";

/** No container, policy, route or binding is left that a ready session does not own. */
function expectClean(r: Rig, sessions: string[] = []) {
  const owned = new Set(
    r.store
      .allBindings()
      .filter((b) => sessions.includes(b.sessionId) && b.containerId)
      .map((b) => b.containerId),
  );
  const pool = new Set(r.store.allPool().map((p) => p.containerId));
  for (const c of r.docker.containers.values())
    expect(owned.has(c.id) || pool.has(c.id), `leaked container ${c.id}`).toBe(
      true,
    );
  const addrs = new Set(
    r.store
      .allBindings()
      .filter((b) => sessions.includes(b.sessionId))
      .map((b) => b.address),
  );
  for (const ip of r.egress.policies.keys())
    expect(addrs.has(ip), `leaked policy for ${ip}`).toBe(true);
  for (const id of r.hub.routes.keys())
    expect(sessions.includes(id), `leaked route ${id}`).toBe(true);
}

describe("a crash at every step of a start is repaired on boot (G9)", () => {
  for (const point of [
    "node.start.after_binding",
    "node.start.after_acquire",
    "node.start.after_policy",
    "node.start.after_configure",
    "node.start.before_ready",
  ]) {
    it(point, async () => {
      const r = makeRig({}, { failpoints: `${point}=throw` });
      await bootWithPool(r);
      const req = startReq();
      await expect(r.agent.start(req)).rejects.toBeInstanceOf(FailpointError);
      // the process "died": a new one starts over the same store and the same world
      r.failpoints.clear();
      r.restart();
      await r.agent.boot();
      await r.agent.idle();
      expect(r.store.getBinding(req.sessionId)).toBeUndefined();
      expectClean(r);
      // the API learns the session is gone
      const removed = r.store
        .pendingReports()
        .filter((x) => x.kind === "removed");
      expect(removed.map((x) => x.sessionId)).toEqual([req.sessionId]);
      // and the node serves new sessions normally
      expect((await r.agent.start(startReq())).result).toBe("ready");
    });
  }
});

describe("a crash at every step of a stop is finished on boot", () => {
  for (const point of [
    "node.stop.after_route_removed",
    "node.stop.after_policy_cleared",
    "node.stop.after_container_removed",
  ]) {
    it(point, async () => {
      const r = makeRig({ poolTarget: 0 });
      await bootWithPool(r);
      const req = startReq();
      await r.agent.start(req);
      r.failpoints.set(point, "throw:once");
      await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
      await r.agent.idle();
      expect(r.store.getBinding(req.sessionId)?.state).toBe("stopping"); // the crash left it half done
      r.restart();
      await r.agent.boot();
      await r.agent.idle();
      expect(r.store.getBinding(req.sessionId)).toBeUndefined();
      expectClean(r);
      const removed = r.store
        .pendingReports()
        .filter((x) => x.kind === "removed");
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ endReason: "client_stop" });
    });
  }
});

describe("boot with ready sessions (I13)", () => {
  it("keeps them, restarts their idle clock, and serves their routes to a connecting gateway", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 20_000 });
    await r.agent.start(req);
    r.clock.advance(15_000);
    r.restart();
    await r.agent.boot();
    const b = r.store.getBinding(req.sessionId)!;
    expect(b.state).toBe("ready");
    expect(b.idleAt).toBe(r.clock.now() + 20_000);
    expect(r.agent.routes().map((x) => x.sessionId)).toEqual([req.sessionId]);
  });

  it("a session left attached across an agent restart is not ended by the idle timer (exit check 7)", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq({ idleTimeoutMs: 10_000 });
    await r.agent.start(req);
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.restart();
    await r.agent.boot();
    // the gateway reconnects and reports what it still holds
    r.agent.handleAttachments("g1", [
      { sessionId: req.sessionId, connections: 1 },
    ]);
    r.clock.advance(60_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("ready");
  });

  it("restores policies after the egress gateway restarted, and tells it so (N13)", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const a = startReq();
    const b = startReq({ network: { deny: ["bad.test"] } });
    await r.agent.start(a);
    await r.agent.start(b);
    r.egress.restart();
    expect(r.egress.policies.size).toBe(0);
    await r.agent.syncEgress();
    expect(r.egress.policies.size).toBe(2);
    expect(r.egress.restoredFlag).toBe(true);
    expect(
      r.egress.policies.get(r.store.getBinding(b.sessionId)!.address!),
    ).toMatchObject({ deny: ["bad.test"] });
  });

  it("removes a policy that no session owns, so no address keeps a way out", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    await r.egress.setPolicy("172.30.1.99", {
      sessionId: startReq().sessionId,
      connectionCap: 5,
    });
    await r.agent.syncEgress();
    expect(r.egress.policies.size).toBe(0);
  });

  it("boot waits for nothing from the API: it works with the API down", async () => {
    const r = makeRig({ poolTarget: 0 });
    r.api.down = true;
    await bootWithPool(r);
    const req = startReq();
    expect((await r.agent.start(req)).result).toBe("ready");
    await r.agent.heartbeat();
    await r.agent.flushReports();
    expect(r.store.getBinding(req.sessionId)?.state).toBe("ready");
  });
});

describe("a store survives the process (G2, G15)", () => {
  it("keeps bindings, the epoch and unsent reports, and never reuses a report id", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    const first = r.store.pendingReports()[0]!;
    r.store.close();
    const again = makeRig({ poolTarget: 0 }, { dbPath: r.dbPath });
    expect(again.store.epoch).toBe(1);
    expect(again.store.pendingReports().map((x) => x.id)).toEqual([first.id]);
    again.store.ackReports([first.id]);
    const next = again.store.enqueueReport((id) => ({
      id,
      at: new Date().toISOString(),
      kind: "removed",
      sessionId: req.sessionId as never,
      endReason: null,
      browserSeconds: 0,
    }));
    expect(next.id).not.toBe(first.id);
  });
});
