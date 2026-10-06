import { CREATION_LABEL } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

/**
 * What the agent tells the invariant checker (`GET /v1/state`). Docker lists a container from
 * the moment it is created, before the agent's call to make it has returned, and keeps listing
 * it until removal has finished: the agent must account for it the whole time, or the checker
 * sees a container nothing owns (a harness race found on the host).
 */
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setImmediate(r));

describe("the agent's account of its containers", () => {
  it("reports pooled browsers Docker already lists but the store does not yet hold", async () => {
    const r = makeRig({ poolTarget: 2, refillAtOnce: 2 });
    await r.agent.boot();
    const g = gate();
    r.docker.runGate = g.p;
    void r.agent.refillPool();
    await tick();
    const listed = [...r.docker.containers.values()];
    expect(listed).toHaveLength(2);
    expect(r.store.allPool()).toHaveLength(0);
    const st = r.agent.state();
    expect(new Set(st.creating)).toEqual(
      new Set(listed.map((c) => c.labels[CREATION_LABEL])),
    );
    g.open();
    r.docker.runGate = null;
    await r.agent.idle();
    expect(r.agent.state().creating).toEqual([]);
    expect(
      r.store
        .allPool()
        .map((p) => p.containerId)
        .sort(),
    ).toEqual(listed.map((c) => c.id).sort());
  });

  it("reports a cold start's container until the session's binding holds it", async () => {
    const r = makeRig({ poolTarget: 0 });
    await r.agent.boot();
    const g = gate();
    r.docker.runGate = g.p;
    const req = startReq();
    const started = r.agent.start(req);
    await tick();
    await tick();
    const [c] = [...r.docker.containers.values()];
    expect(c).toBeDefined();
    expect(r.store.getBinding(req.sessionId)?.containerId).toBeNull();
    expect(r.agent.state().creating).toEqual([c!.labels[CREATION_LABEL]]);
    g.open();
    r.docker.runGate = null;
    expect((await started).result).toBe("ready");
    expect(r.store.getBinding(req.sessionId)?.containerId).toBe(c!.id);
    expect(r.agent.state().creating).toEqual([]);
  });

  it("lets go of a creation that failed", async () => {
    const r = makeRig({ poolTarget: 1 });
    await r.agent.boot();
    r.docker.failRuns = 1;
    await r.agent.refillPool();
    await r.agent.idle();
    expect(r.agent.state().creating).toEqual([]);
  });

  it("reports a container being removed after its record is gone", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const [p] = r.store.allPool();
    // The pooled browser died quietly: the start finds it dead, drops it, and removes it.
    r.docker.containers.get(p!.containerId)!.running = false;
    const g = gate();
    r.docker.removeGate = g.p;
    const started = r.agent.start(startReq());
    for (let i = 0; i < 5; i++) await tick();
    expect(r.store.allPool().map((x) => x.containerId)).not.toContain(
      p!.containerId,
    );
    expect(r.docker.containers.has(p!.containerId)).toBe(true);
    expect(r.agent.state().retiring).toContain(p!.containerId);
    g.open();
    r.docker.removeGate = null;
    await started;
    await r.agent.idle();
    expect(r.agent.state().retiring).not.toContain(p!.containerId);
  });
});
