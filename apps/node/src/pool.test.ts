import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

describe("pool refill under demand", () => {
  it("starts a replacement the moment a pooled browser is taken, not on the next tick", async () => {
    const r = makeRig({ slotsTotal: 6, poolTarget: 2 });
    await bootWithPool(r);
    const before = r.docker.runCalls;
    await r.agent.start(startReq());
    // No timer has run (the rig drives none): the take itself began the refill.
    expect(r.docker.runCalls).toBe(before + 1);
    await r.agent.idle();
    expect(r.store.allPool().filter((p) => p.state === "hot")).toHaveLength(2);
  });

  it("grows the pool past its target to meet a burst, but never into slots sessions hold", async () => {
    const r = makeRig({ slotsTotal: 8, poolTarget: 2, refillAtOnce: 4 });
    await bootWithPool(r);
    for (let i = 0; i < 4; i++) await r.agent.start(startReq());
    await r.agent.refillPool();
    await r.agent.idle();
    // Four starts in the demand window: the pool aims for 4, and 8 slots - 4 sessions leaves room for 4.
    expect(r.store.allPool()).toHaveLength(4);

    const s = makeRig({ slotsTotal: 5, poolTarget: 1, refillAtOnce: 4 });
    await bootWithPool(s);
    for (let i = 0; i < 4; i++) await s.agent.start(startReq());
    await s.agent.refillPool();
    await s.agent.idle();
    expect(s.store.allPool()).toHaveLength(1); // 5 slots - 4 sessions
  });

  it("returns to its target once the burst is over, and respects poolMax", async () => {
    const r = makeRig({
      slotsTotal: 8,
      poolTarget: 2,
      refillAtOnce: 4,
      poolMax: 3,
    });
    await bootWithPool(r);
    for (let i = 0; i < 4; i++) await r.agent.start(startReq());
    await r.agent.refillPool();
    await r.agent.idle();
    expect(r.store.allPool()).toHaveLength(3);
    r.clock.advance(11_000);
    for (const b of r.store.allBindings())
      await r.agent.stop({
        sessionId: b.sessionId,
        reason: "client_stop",
      } as never);
    await r.agent.idle();
    // The burst has left the window: nothing more is made beyond what is already warm.
    const made = r.docker.runCalls;
    await r.agent.refillPool();
    await r.agent.idle();
    expect(r.docker.runCalls).toBe(made);
  });

  it("tells the API a session's slot is free as soon as its container is gone", async () => {
    const r = makeRig({ reportOnRemoval: true });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    await new Promise((res) => setTimeout(res, 20));
    // Sent and acknowledged without any heartbeat having run.
    expect(r.store.pendingReports(100)).toEqual([]);
    expect(
      r.api.allReports.some(
        (x) => x.kind === "removed" && x.sessionId === req.sessionId,
      ),
    ).toBe(true);
  });

  it("keeps warm browsers beyond the slots with headroom, but never admits more sessions than slots", async () => {
    const r = makeRig({
      slotsTotal: 4,
      poolTarget: 2,
      refillAtOnce: 6,
      poolHeadroom: 3,
    });
    await bootWithPool(r);
    for (let i = 0; i < 4; i++) await r.agent.start(startReq());
    await r.agent.refillPool();
    await r.agent.idle();
    // Every slot holds a session, and the pool still has 3 warm browsers in the headroom.
    expect(r.store.allBindings()).toHaveLength(4);
    expect(r.store.allPool()).toHaveLength(3);
    expect((await r.agent.start(startReq())).result).toBe("refused");
  });

  it("does not lose a pooled browser made while reconciliation is running", async () => {
    const r = makeRig({ slotsTotal: 4, poolTarget: 1 });
    await bootWithPool(r);
    // Reconciliation lists containers, then a refill makes a new pooled browser before it walks the pool.
    const list = r.docker.list.bind(r.docker);
    r.docker.list = async () => {
      const snapshot = await list();
      const old = r.store.allPool()[0]!.containerId;
      r.store.deletePool(old); // a session took the only one...
      await r.docker.remove(old);
      await r.agent.refillPool(); // ...and its replacement starts now, after the snapshot
      await new Promise((res) => setTimeout(res, 5));
      return snapshot;
    };
    await r.agent.reconcile();
    r.docker.list = list;
    await r.agent.idle();
    const made = r.store.allPool();
    expect(made).toHaveLength(1);
    expect(r.docker.containers.has(made[0]!.containerId)).toBe(true);
  });

  it("waits for warming browsers up to its bound, then makes its own", async () => {
    const r = makeRig({ slotsTotal: 6, poolTarget: 2, warmWaitMs: 1_500 });
    await r.agent.boot();
    // Two pooled browsers that will never become ready.
    const runs = r.docker.runCalls;
    const realRun = r.docker.run.bind(r.docker);
    r.docker.run = async (spec) => {
      const info = await realRun(spec);
      if (r.docker.runCalls <= runs + 2)
        r.runtime.neverReady.add(info.address as string);
      return info;
    };
    await r.agent.refillPool();
    await new Promise((res) => setTimeout(res, 20));
    expect(
      r.store.allPool().filter((p) => p.state === "starting"),
    ).toHaveLength(2);
    const t0 = performance.now();
    const res = await r.agent.start(startReq());
    const took = performance.now() - t0;
    expect(res).toMatchObject({ result: "ready", startPath: "cold" });
    // Bounded by the warm wait (1.5 s here), not by however long the warming ones take.
    expect(took).toBeGreaterThan(1_400);
    expect(took).toBeLessThan(3_500);
  });

  it("never has more than refillAtOnce browsers being made or warming at once", async () => {
    const r = makeRig({ slotsTotal: 10, poolTarget: 10, refillAtOnce: 2 });
    await r.agent.boot();
    // Browsers that stay warming, so nothing finishes while refills keep being asked for.
    const realRun = r.docker.run.bind(r.docker);
    r.docker.run = async (spec) => {
      const info = await realRun(spec);
      r.runtime.neverReady.add(info.address as string);
      return info;
    };
    for (let i = 0; i < 6; i++) {
      await r.agent.refillPool();
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(r.store.allPool().length).toBeLessThanOrEqual(2);
    expect(r.docker.runCalls).toBeLessThanOrEqual(2);
  });

  it("takes a pooled browser that is still being made rather than adding another", async () => {
    const r = makeRig({ slotsTotal: 6, poolTarget: 1, refillAtOnce: 1 });
    await r.agent.boot();
    // Docker is slow: the one pooled browser on its way takes 300 ms to be made.
    const realRun = r.docker.run.bind(r.docker);
    r.docker.run = async (spec) => {
      await new Promise((res) => setTimeout(res, 300));
      return realRun(spec);
    };
    await r.agent.refillPool();
    expect(r.store.allPool()).toHaveLength(0); // still inside Docker
    const res = await r.agent.start(startReq());
    expect(res.result).toBe("ready");
    // It waited for the one on its way: only that container was made for this start.
    expect(r.docker.runCalls).toBe(1);
  });

  it("freezes a stopped session's container and removes it once Docker is quiet", async () => {
    const r = makeRig({ deferRemoval: true, reportOnRemoval: true });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const cid = r.store.getBinding(req.sessionId)!.containerId!;
    await r.agent.idle(); // the refill after the take is done: nothing is being made
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await new Promise((res) => setTimeout(res, 20));
    // Frozen, its slot already free and reported, but still there...
    expect(r.docker.paused.has(cid)).toBe(true);
    expect(r.docker.containers.has(cid)).toBe(true);
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    expect(r.egress.policies.size).toBe(0); // and with no way out
    // ...until the reaper runs with no pooled browser being made.
    await r.agent.reap();
    expect(r.docker.containers.has(cid)).toBe(false);
  });

  it("removes at once when the freeze fails or too many already wait", async () => {
    const r = makeRig({ slotsTotal: 8, deferRemoval: true });
    await bootWithPool(r);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const req = startReq();
      await r.agent.start(req);
      ids.push(r.store.getBinding(req.sessionId)!.containerId!);
      await r.agent.stop({
        sessionId: req.sessionId,
        reason: "client_stop",
      } as never);
    }
    await r.agent.idle();
    // At most four wait frozen; the rest went the ordinary way.
    expect(
      ids.filter((id) => r.docker.containers.has(id)).length,
    ).toBeLessThanOrEqual(4);
    expect(
      ids.filter((id) => r.docker.removed.includes(id)).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("removes at once instead of freezing when the host is short of memory", async () => {
    const r = makeRig({ deferRemoval: true });
    (
      r.agent as unknown as { d: { memAvailableMb: () => number } }
    ).d.memAvailableMb = () => 2_000;
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const cid = r.store.getBinding(req.sessionId)!.containerId!;
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    expect(r.docker.paused.has(cid)).toBe(false);
    expect(r.docker.containers.has(cid)).toBe(false);
  });

  it("reconciles on the death of a container it counts on, not on its own removals", async () => {
    const r = makeRig({ deferRemoval: true });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const cid = r.store.getBinding(req.sessionId)!.containerId!;
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    const before = r.docker.listCalls;
    r.agent.containerDied(cid); // a retired container the agent removed itself
    await r.agent.idle();
    expect(r.docker.listCalls).toBe(before);

    const pooled = r.store.allPool()[0]!.containerId;
    r.docker.kill(pooled);
    r.agent.containerDied(pooled);
    await r.agent.reconcile();
    expect(r.docker.listCalls).toBeGreaterThan(before);
    expect(r.store.allPool().some((p) => p.containerId === pooled)).toBe(false);
  });

  it("runs one reconcile pass at a time, and one more for calls made during it", async () => {
    const r = makeRig();
    await bootWithPool(r);
    const before = r.docker.listCalls;
    await Promise.all([
      r.agent.reconcile(),
      r.agent.reconcile(),
      r.agent.reconcile(),
      r.agent.reconcile(),
    ]);
    expect(r.docker.listCalls - before).toBe(2);
  });

  it("removes hot browsers left over from a larger pool when it boots with a smaller one", async () => {
    const r = makeRig({ slotsTotal: 6, poolTarget: 4, refillAtOnce: 4 });
    await bootWithPool(r);
    expect(r.store.allPool()).toHaveLength(4);
    r.config.poolTarget = 0;
    await r.restart().boot();
    expect(r.store.allPool()).toHaveLength(0);
    expect(r.docker.containers.size).toBe(0);
  });
});
