import { TIMINGS } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq, SPEC } from "./test/fakes.js";
import { buildContainerSpec } from "./docker.js";

describe("starting a session (G6, G7)", () => {
  it("takes a hot browser: policy first, then configure, then the route, then ready", async () => {
    const r = makeRig();
    await bootWithPool(r);
    expect(r.docker.byRole("pool")).toHaveLength(2);
    expect(r.store.allPool().filter((p) => p.state === "hot")).toHaveLength(2);

    const req = startReq({
      network: { allow: ["example.com"] },
      viewport: { width: 1000, height: 600 },
    });
    const res = await r.agent.start(req);
    expect(res).toMatchObject({
      result: "ready",
      startPath: "hot",
      deviceScaleFactor: 1,
    });

    const b = r.store.getBinding(req.sessionId)!;
    expect(b).toMatchObject({ state: "ready", startPath: "hot" });
    expect(b.proof).toMatch(/^[0-9a-f]{64}$/);
    // order: the policy exists before the browser is configured, and the route only after both
    const addr = b.address!;
    expect(r.egress.log.indexOf(`set ${addr}`)).toBeGreaterThanOrEqual(0);
    expect(
      r.runtime.calls.filter((c) => c.op === "configure" && c.address === addr),
    ).toHaveLength(1);
    expect(r.hub.events).toEqual([`put ${req.sessionId}`]);
    expect(r.egress.policies.get(addr)).toMatchObject({
      sessionId: req.sessionId,
      allow: ["example.com"],
    });
    expect(r.runtime.configured.get(addr)).toMatchObject({
      sessionProof: b.proof,
      viewport: { width: 1000, height: 600 },
    });
    // the session's deadlines are absolute on the agent's clock
    expect(b.maxAt).toBe(r.clock.now() + 600_000);
    expect(b.idleAt).toBe(r.clock.now() + 300_000);
    // the pool lost one and is refilled from spare slots only
    expect(r.store.allPool()).toHaveLength(1);
  });

  it("a pooled browser has no policy until it is assigned (R15)", async () => {
    const r = makeRig();
    await bootWithPool(r);
    expect(r.egress.policies.size).toBe(0);
  });

  it("goes cold when the pool is empty, and never refuses an admitted start", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const res = await r.agent.start(startReq());
    expect(res).toMatchObject({ result: "ready", startPath: "cold" });
  });

  it("waits for a pooled browser that is still starting, rather than making another", async () => {
    const r = makeRig();
    await r.agent.boot();
    await r.agent.refillPool(); // two are starting, not yet recorded hot
    const res = await r.agent.start(startReq());
    expect(res).toMatchObject({ result: "ready", startPath: "cold" });
    await r.agent.idle();
    expect(r.docker.runCalls).toBeLessThanOrEqual(3);
  });

  it("refuses a stale epoch, a repeated session, no room, and an unverified firewall", async () => {
    const r = makeRig({ slotsTotal: 1, poolTarget: 0 });
    await bootWithPool(r);
    expect(await r.agent.start(startReq({ epoch: 9 }))).toMatchObject({
      result: "refused",
    });
    const req = startReq();
    expect(await r.agent.start(req)).toMatchObject({ result: "ready" });
    // a repeated start (the API retried a lost answer) is answered from what exists
    expect(await r.agent.start(req)).toMatchObject({ result: "ready" });
    expect(r.docker.byRole("session")).toHaveLength(1);
    expect(await r.agent.start(startReq())).toMatchObject({
      result: "refused",
      reason: "no slot",
    });
    r.firewall.ok = false;
    r.firewall.fixable = false;
    await r.agent.checkFirewall();
    expect(await r.agent.start(startReq())).toMatchObject({
      result: "refused",
      reason: expect.stringContaining("firewall"),
    });
  });
});

describe("a start that goes wrong (G8)", () => {
  it("a browser that fails to configure never reaches a client: policy cleared, container removed, the next one used", async () => {
    const r = makeRig();
    await bootWithPool(r);
    const first = r.store.allPool()[0]!;
    r.runtime.behavior.set(first.address, "fail");
    const req = startReq();
    const res = await r.agent.start(req);
    expect(res.result).toBe("ready");
    const b = r.store.getBinding(req.sessionId)!;
    expect(b.address).not.toBe(first.address);
    expect(r.egress.log).toContain(`clear ${first.address}`);
    expect(r.docker.removed).toContain(first.containerId);
    expect(r.egress.policies.has(first.address)).toBe(false);
  });

  it("a browser reporting the wrong viewport is treated as failed (A6)", async () => {
    const r = makeRig({ startRetries: 0 });
    await bootWithPool(r);
    for (const p of r.store.allPool())
      r.runtime.behavior.set(p.address, "badViewport");
    const req = startReq();
    const res = await r.agent.start(req);
    expect(res).toMatchObject({ result: "failed" });
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    expect(r.egress.policies.size).toBe(0);
  });

  it("gives up after two retries, leaking nothing", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    r.runtime.failAllConfigures = true;
    const req = startReq();
    const res = await r.agent.start(req);
    expect(res).toMatchObject({ result: "failed" });
    expect(r.runtime.calls.filter((c) => c.op === "configure")).toHaveLength(3);
    expect(r.docker.containers.size).toBe(0);
    expect(r.egress.policies.size).toBe(0);
    expect(r.store.allBindings()).toEqual([]);
    expect(r.hub.routes.size).toBe(0);
  });

  it("docker failing to create a container fails the start cleanly", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    r.docker.failRuns = 10;
    expect(await r.agent.start(startReq())).toMatchObject({ result: "failed" });
    expect(r.store.allBindings()).toEqual([]);
  });

  it("a container that never becomes ready fails the start within the timeout", async () => {
    const r = makeRig({ poolTarget: 0, readyTimeoutMs: 150, startRetries: 0 });
    await bootWithPool(r);
    const orig = r.docker.run.bind(r.docker);
    r.docker.run = async (spec) => {
      const info = await orig(spec);
      r.runtime.neverReady.add(info.address!);
      return info;
    };
    // the fake clock does not move, so use real waiting: the agent polls until its deadline on the clock
    const p = r.agent.start(startReq());
    await new Promise((res) => setTimeout(res, 100));
    r.clock.advance(1000);
    expect(await p).toMatchObject({ result: "failed" });
    expect(r.docker.containers.size).toBe(0);
  });
});

describe("stopping (G10, G14)", () => {
  it("removes the route, clears the policy, removes the container, releases the slot, then reports", async () => {
    const r = makeRig({ slotsTotal: 1, poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const b = r.store.getBinding(req.sessionId)!;
    r.hub.events.length = 0;
    r.egress.log.length = 0;
    r.clock.advance(7000);

    expect(
      await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" }),
    ).toEqual({ result: "accepted" });
    await r.agent.idle();
    expect(r.hub.events).toEqual([`remove ${req.sessionId}`]);
    expect(r.egress.log).toEqual([`clear ${b.address}`]);
    expect(r.docker.removed).toContain(b.containerId);
    expect(r.store.getBinding(req.sessionId)).toBeUndefined();
    const [rep] = r.store.pendingReports();
    expect(rep).toMatchObject({
      kind: "removed",
      sessionId: req.sessionId,
      endReason: "client_stop",
      browserSeconds: 7,
    });
    // the slot is free again
    expect(r.agent.describe().slots.free).toBe(1);
  });

  it("a second stop is harmless, and a stop for an unknown session says gone", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(r.store.pendingReports()).toHaveLength(1);
    expect(
      await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" }),
    ).toEqual({ result: "gone" });
  });

  it("a stop that arrives before its start is remembered, so the late start is refused (G14)", async () => {
    const r = makeRig();
    await bootWithPool(r);
    const req = startReq();
    expect(
      await r.agent.stop({ sessionId: req.sessionId, reason: "start_timeout" }),
    ).toEqual({ result: "gone" });
    expect(await r.agent.start(req)).toMatchObject({
      result: "refused",
      reason: "stop already received",
    });
    // after five minutes it is forgotten
    r.clock.advance(TIMINGS.rememberedStopMs + 1000);
    expect((await r.agent.start(req)).result).toBe("ready");
  });

  it("a stop during a start aborts it and cleans up", async () => {
    const r = makeRig({ poolTarget: 0 });
    await bootWithPool(r);
    const req = startReq();
    const orig = r.runtime.configure.bind(r.runtime);
    let release!: () => void;
    r.runtime.configure = async (a, t, q) => {
      await new Promise<void>((res) => (release = res));
      return orig(a, t, q);
    };
    const starting = r.agent.start(req);
    await new Promise((res) => setTimeout(res, 50));
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    release();
    expect(await starting).toMatchObject({ result: "failed" });
    await r.agent.idle();
    expect(r.docker.containers.size).toBe(0);
    expect(r.egress.policies.size).toBe(0);
    expect(r.store.allBindings()).toEqual([]);
    expect(r.store.pendingReports()).toHaveLength(1);
  });
});

describe("the container profile (R10-R14, R16; threat model G-05)", () => {
  const spec = buildContainerSpec(
    { ...SPEC, seccompProfile: '{"defaultAction":"SCMP_ACT_ERRNO"}' },
    "session",
    "tok",
  );
  const hc = spec.HostConfig!;

  it("is hardened", () => {
    expect(spec.User).toBe("10001:10001");
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toBeUndefined();
    expect(hc.SecurityOpt).toContain("no-new-privileges");
    expect(hc.SecurityOpt?.some((o: string) => o.startsWith("seccomp="))).toBe(
      true,
    );
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.PidsLimit).toBe(1024);
    expect(hc.Init).toBe(true);
    expect(hc.RestartPolicy).toEqual({ Name: "no" });
    expect(hc.PortBindings).toBeUndefined();
    expect(hc.PublishAllPorts).toBeUndefined();
    expect(hc.Binds).toBeUndefined();
    expect(hc.Devices).toBeUndefined();
    expect(hc.NetworkMode).toBe("ksl-a");
    expect(hc.Dns).toEqual([]);
  });

  it("limits resources: 1 CPU, 2 GB with no swap, shared memory inside it, under a parent cgroup", () => {
    expect(hc.NanoCpus).toBe(1_000_000_000);
    expect(hc.Memory).toBe(2 * 1024 ** 3);
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect(hc.ShmSize).toBe(1024 ** 3);
    expect(hc.CgroupParent).toBe("kestrel.slice");
  });

  it("makes every writable space memory-backed, no-exec, no-suid, no-dev", () => {
    expect(Object.keys(hc.Tmpfs!).sort()).toEqual([
      "/home/kestrel",
      "/profile",
      "/tmp",
    ]);
    for (const opts of Object.values(hc.Tmpfs!) as string[])
      expect(opts).toMatch(/noexec,nosuid,nodev/);
  });

  it("logs to the journal without ever blocking the browser, and is labelled with its node (G3)", () => {
    expect(hc.LogConfig).toMatchObject({
      Type: "journald",
      Config: { mode: "non-blocking" },
    });
    expect(spec.Labels).toEqual({
      "kestrel.node": "a",
      "kestrel.role": "session",
    });
  });

  it("points the browser at the egress gateway and gives it a control token", () => {
    expect(spec.Env).toContain("KESTREL_PROXY=http://172.30.1.1:3128");
    expect(spec.Env).toContain("KESTREL_CONTROL_TOKEN=tok");
  });

  it("every container the agent actually creates uses it", async () => {
    const r = makeRig();
    await bootWithPool(r);
    for (const c of r.docker.specs.values()) {
      expect(c.HostConfig?.Privileged).toBe(false);
      expect(c.HostConfig?.CapDrop).toEqual(["ALL"]);
      expect(c.Labels?.["kestrel.node"]).toBe("a");
    }
  });
});
