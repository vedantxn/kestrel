import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

/*
 * The node's half of time zones (docs/lld/upstream-proxy.md) and of byte counters per session
 * (threat model G-20), and SOCKS5 and TLS upstreams carried through.
 */

const removedReport = (
  r: ReturnType<typeof makeRig>,
  sessionId: string,
): Record<string, unknown> | undefined =>
  r.store
    .pendingReports()
    .find(
      (x) => x.kind === "removed" && x.sessionId === (sessionId as never),
    ) as Record<string, unknown> | undefined;

describe("a session's time zone", () => {
  it("is applied by runtimed at configure, before the session is ready", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = { ...startReq(), timezone: "Europe/Berlin" };
    expect((await r.agent.start(req)).result).toBe("ready");
    const address = r.store.getBinding(req.sessionId)!.address!;
    expect(r.runtime.configured.get(address)?.timezone).toBe("Europe/Berlin");
  });

  it("is not sent when the session has none", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const address = r.store.getBinding(req.sessionId)!.address!;
    expect(r.runtime.configured.get(address)).not.toHaveProperty("timezone");
  });

  it("fails the start, without spending the pool, on a runtimed that does not apply it", async () => {
    const r = makeRig({ poolTarget: 2, startRetries: 2 });
    await bootWithPool(r);
    for (const c of r.docker.containers.values())
      if (c.address) r.runtime.behavior.set(c.address, "noTimezone");
    const before = r.docker.removed.length;
    const res = await r.agent.start({ ...startReq(), timezone: "Asia/Tokyo" });
    expect(res).toMatchObject({ result: "failed" });
    expect(r.hub.routes.size).toBe(0);
    expect(r.egress.policies.size).toBe(0);
    expect(r.docker.removed.length - before).toBe(1);
    // The same runtimed still serves a session that asked for no time zone.
    expect((await r.agent.start(startReq())).result).toBe("ready");
  });
});

describe("byte counters per session (G-20)", () => {
  it("are polled, survive a gateway restart, take the final counts at the clear, and go out in the removed report", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const address = r.store.getBinding(req.sessionId)!.address!;

    r.egress.bytes.set(address, { up: 1_000, down: 50_000 });
    await r.agent.pollEgressUsage();
    expect(r.store.egressBytes(req.sessionId)).toEqual({
      up: 1_000,
      down: 50_000,
    });

    // The gateway restarts: a new epoch, counting from zero again.
    r.egress.restart();
    r.egress.denialEpoch = "e2";
    await r.agent.syncEgress();
    r.egress.bytes.set(address, { up: 200, down: 7_000 });
    await r.agent.pollEgressUsage();
    expect(r.store.egressBytes(req.sessionId)).toEqual({
      up: 1_200,
      down: 57_000,
    });

    // More traffic before the stop: the clear answers it.
    r.egress.bytes.set(address, { up: 300, down: 9_000 });
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(removedReport(r, req.sessionId)).toMatchObject({
      egressBytesUp: 1_300,
      egressBytesDown: 59_000,
    });
    // Nothing is left behind in the store.
    expect(
      r.store.db.prepare("SELECT count(*) AS n FROM egress_bytes").get(),
    ).toEqual({ n: 0 });
  });

  it("are zero, and nothing breaks, against a gateway from before byte counters", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    r.egress.noUsage = true;
    const req = startReq();
    await r.agent.start(req);
    await r.agent.pollEgressUsage();
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(removedReport(r, req.sessionId)).toMatchObject({
      egressBytesUp: 0,
      egressBytesDown: 0,
    });
  });

  it("ignore sessions this node does not hold, and never go backwards within an epoch", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    r.store.recordEgressBytes("ses_01h0000000000000000000000z", "e1", 5, 5);
    expect(
      r.store.db.prepare("SELECT count(*) AS n FROM egress_bytes").get(),
    ).toEqual({ n: 0 });
    r.store.recordEgressBytes(req.sessionId, "e1", 100, 100);
    r.store.recordEgressBytes(req.sessionId, "e1", 40, 40);
    expect(r.store.egressBytes(req.sessionId)).toEqual({ up: 100, down: 100 });
  });
});

describe("SOCKS5 and TLS upstreams on the node", () => {
  const socks = {
    scheme: "socks5" as const,
    host: "proxy.example.com",
    port: 1080,
    username: "u",
    password: "socks-pw",
  };

  it("are pushed with their scheme, repaired if a policy lost it, and scrubbed of the password with the scheme kept", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = startReq({ network: { upstream: socks } });
    expect((await r.agent.start(req)).result).toBe("ready");
    const address = r.store.getBinding(req.sessionId)!.address!;
    expect(r.egress.policies.get(address)?.upstream).toEqual(socks);

    // The gateway holds the same host and port but as plain HTTP: a different exit, pushed again.
    const asHttp = {
      host: socks.host,
      port: socks.port,
      username: socks.username,
      password: socks.password,
    };
    r.egress.policies.set(address, {
      ...r.egress.policies.get(address)!,
      upstream: asHttp,
    });
    await r.agent.syncEgress();
    expect(r.egress.policies.get(address)?.upstream).toEqual(socks);

    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(
      JSON.stringify(r.store.db.prepare("SELECT * FROM sessions").all()),
    ).not.toContain("socks-pw");
  });
});
