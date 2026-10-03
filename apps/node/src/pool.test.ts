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
});
