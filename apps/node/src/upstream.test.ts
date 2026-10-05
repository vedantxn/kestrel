import { Writable } from "node:stream";
import { createLogger } from "@kestrel/shared";
import { describe, expect, it } from "vitest";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

const PASSWORD = "pr0xy-pa55-node";
const upstream = {
  host: "proxy.example.com",
  port: 3128,
  username: "u",
  password: PASSWORD,
};
const proxied = () => startReq({ network: { upstream } });

function capture() {
  const lines: string[] = [];
  const log = createLogger(
    "agent-test",
    "debug",
    new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  return { log, text: () => lines.join("") };
}

describe("a session's upstream proxy on the node (T-47)", () => {
  it("is stored with the session and pushed to the egress gateway before the browser is used", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    const res = await r.agent.start(req);
    expect(res.result).toBe("ready");
    const b = r.store.getBinding(req.sessionId)!;
    expect(b.policy.upstream).toEqual(upstream);
    expect(r.egress.policies.get(b.address!)).toMatchObject({
      sessionId: req.sessionId,
      upstream,
    });
  });

  it("fails the start, clears the policy and does not retry, when the gateway does not confirm the proxy", async () => {
    const r = makeRig({ poolTarget: 2, startRetries: 2 });
    await bootWithPool(r);
    r.egress.legacy = true;
    const before = r.docker.removed.length;
    const res = await r.agent.start(proxied());
    expect(res).toMatchObject({ result: "failed" });
    expect(r.egress.policies.size).toBe(0);
    expect(r.hub.routes.size).toBe(0);
    // One pooled browser spent, not one per retry.
    expect(r.docker.removed.length - before).toBe(1);
  });

  it("still starts sessions without a proxy against a gateway from before proxies", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    r.egress.legacy = true;
    expect((await r.agent.start(startReq())).result).toBe("ready");
  });

  it("pushes the proxy again after the egress gateway restarts", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    await r.agent.start(req);
    const address = r.store.getBinding(req.sessionId)!.address!;
    // A restarted gateway is empty and refuses everything until the agent restores it (N13).
    r.egress.policies.clear();
    r.egress.restoredFlag = false;
    await r.agent.syncEgress();
    expect(r.egress.policies.get(address)?.upstream).toEqual(upstream);
    expect(r.egress.restoredFlag).toBe(true);
  });

  it("repairs a policy that lost its proxy, rather than leave the session going out directly", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    await r.agent.start(req);
    const address = r.store.getBinding(req.sessionId)!.address!;
    const direct = { ...r.egress.policies.get(address)! };
    delete direct.upstream;
    r.egress.policies.set(address, direct);
    await r.agent.syncEgress();
    expect(r.egress.policies.get(address)?.upstream).toEqual(upstream);
  });

  it("clears a resynced policy whose proxy the gateway will not confirm", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    await r.agent.start(req);
    r.egress.policies.clear();
    r.egress.legacy = true;
    await r.agent.syncEgress();
    expect(r.egress.policies.size).toBe(0);
  });

  it("scrubs the password from the store once the session's policy is cleared (T-45)", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    await r.agent.start(req);
    const id = req.sessionId as string;
    // Hold the teardown after the policy is cleared, so the row can be read.
    const b = r.store.getBinding(id)!;
    const removal = r.docker.remove.bind(r.docker);
    let seen: unknown;
    r.docker.remove = async (cid: string) => {
      if (cid === b.containerId) seen = r.store.getBinding(id)?.policy;
      return removal(cid);
    };
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(seen).toEqual({
      upstream: { host: "proxy.example.com", port: 3128, username: "u" },
    });
    expect(r.store.getBinding(id)).toBeUndefined();
    const raw = r.store.db
      .prepare("SELECT policy FROM sessions")
      .all()
      .map((x) => JSON.stringify(x))
      .join("");
    expect(raw).not.toContain(PASSWORD);
  });

  it("passes the gateway's upstream denials on as events", async () => {
    const r = makeRig({ poolTarget: 1 });
    await bootWithPool(r);
    const req = proxied();
    await r.agent.start(req);
    r.egress.denialList = [
      {
        seq: 1,
        sessionId: req.sessionId,
        host: "example.com",
        port: 443,
        reason: "upstream_auth_failed",
        count: 1,
        at: new Date().toISOString(),
      },
    ];
    await r.agent.pollDenials();
    expect(
      r.store.pendingReports().filter((x) => x.kind === "event"),
    ).toMatchObject([
      {
        event: {
          type: "egress.denied",
          data: { host: "example.com", reason: "upstream_auth_failed" },
        },
      },
    ]);
  });

  it("never logs the password, even when the gateway fails", async () => {
    const { log, text } = capture();
    const r = makeRig({ poolTarget: 1 }, { log });
    await bootWithPool(r);
    r.egress.legacy = true;
    await r.agent.start(proxied());
    r.egress.legacy = false;
    const req = proxied();
    await r.agent.start(req);
    await r.agent.stop({ sessionId: req.sessionId, reason: "client_stop" });
    await r.agent.idle();
    expect(text().length).toBeGreaterThan(0);
    expect(text()).not.toContain(PASSWORD);
  });
});
