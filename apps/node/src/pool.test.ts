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
});
