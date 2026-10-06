import { statSync } from "node:fs";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  AgentState,
  HARNESS_PATHS,
  type MicroVmRuntimeView,
} from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { MicroVmHooks } from "./agent.js";
import { createHarnessServer, listenHarness } from "./harness.js";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

const log = createLogger("harness-test", "silent");

/** A microVM node's hooks over the fake Docker: probe VMs are containers labelled as probes. */
function vmHooks(rig: () => ReturnType<typeof makeRig>): MicroVmHooks {
  return {
    describe: () =>
      ({
        dir: "/data/kestrel-vm",
        cgroupParent: "kestrel-vm",
        uid: 10002,
        gid: 10002,
        vcpus: 1,
        memMib: 2048,
        subnetPrefix: "172.30.1",
        octets: [128, 254],
        bridge: "ksl-a",
        bridgeIp: "172.30.1.1",
        egressPort: 3128,
        pages: "2M",
        netnsTarget: 8,
        netns: { ready: [], inUse: [], making: [] },
      }) satisfies MicroVmRuntimeView,
    runProbe: async (spec) => {
      const info = await rig().docker.run(spec);
      return { ...info, id: `vm-${"a".repeat(20)}${info.id.slice(1, 5)}` };
    },
  };
}

describe("probe policies (G-23; the reconcile race)", () => {
  it("does not exist unless the harness surface is on", async () => {
    const r = makeRig();
    await r.agent.boot();
    await expect(
      r.agent.leaseProbePolicy("172.30.1.90", 60_000),
    ).rejects.toMatchObject({ status: 404 });
    expect(r.agent.state().harness.enabled).toBe(false);
  });

  it("keeps a probe's policy through reconciliation, which clears any policy it does not own", async () => {
    const r = makeRig({}, { harness: true });
    await r.agent.boot();
    const lease = await r.agent.leaseProbePolicy("172.30.1.90", 60_000);
    expect(r.egress.policies.get("172.30.1.90")?.sessionId).toBe(
      lease.sessionId,
    );
    // A policy set behind the agent's back (what the harness used to do) is cleared...
    await r.egress.setPolicy("172.30.1.91", {
      sessionId: "ses_x" as never,
      connectionCap: 64,
    });
    await r.agent.reconcile();
    await r.agent.syncEgress();
    expect(r.egress.policies.has("172.30.1.91")).toBe(false);
    // ...a leased one is kept, and given back after the egress gateway restarts.
    expect(r.egress.policies.get("172.30.1.90")?.sessionId).toBe(
      lease.sessionId,
    );
    r.egress.restart();
    await r.agent.syncEgress();
    expect(r.egress.policies.get("172.30.1.90")?.sessionId).toBe(
      lease.sessionId,
    );
    expect(
      AgentState.parse(r.agent.state()).harness.probePolicies,
    ).toMatchObject([{ ip: "172.30.1.90", sessionId: lease.sessionId }]);
    expect(await r.agent.releaseProbePolicy("172.30.1.90")).toBe(true);
    expect(r.egress.policies.has("172.30.1.90")).toBe(false);
  });

  it("refuses an address that is not a free one on this node's bridge", async () => {
    const r = makeRig({}, { harness: true });
    await bootWithPool(r);
    const req = startReq();
    await r.agent.start(req);
    const taken = r.store.getBinding(req.sessionId)!.address!;
    const pooled = r.store.allPool()[0]!.address;
    for (const ip of [
      taken,
      pooled,
      "172.30.1.1",
      "172.30.2.9",
      "10.0.0.1",
      "nonsense",
      "172.30.1.255",
    ])
      await expect(
        r.agent.leaseProbePolicy(ip, 60_000),
        ip,
      ).rejects.toMatchObject({ status: 409 });
  });

  it("ends a lease at its deadline, and never lets it reach a browser that takes the address", async () => {
    const r = makeRig({ poolTarget: 1 }, { harness: true });
    await r.agent.boot();
    await r.agent.leaseProbePolicy("172.30.1.90", 5_000);
    r.clock.advance(6_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.egress.policies.has("172.30.1.90")).toBe(false);
    expect(r.agent.state().harness.probePolicies).toEqual([]);

    // The fake Docker hands out 172.30.1.2 next: a harness that died left a lease on it.
    await r.agent.leaseProbePolicy("172.30.1.2", 60_000);
    await r.agent.refillPool();
    await r.agent.idle();
    expect(r.store.allPool()[0]?.address).toBe("172.30.1.2");
    expect(r.egress.policies.has("172.30.1.2")).toBe(false);
    expect(r.agent.state().harness.probePolicies).toEqual([]);
  });
});

describe("probe VMs (G-23)", () => {
  it("are made only on a microVM node", async () => {
    const r = makeRig({}, { harness: true });
    await r.agent.boot();
    await expect(r.agent.makeProbeVm(60_000)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("are made with no policy, survive reconciliation, run probes, and are removed", async () => {
    const ref: { rig?: ReturnType<typeof makeRig> } = {};
    const r = (ref.rig = makeRig(
      { poolTarget: 0 },
      { harness: true, microvm: vmHooks(() => ref.rig!) },
    ));
    await r.agent.boot();
    const vm = await r.agent.makeProbeVm(60_000);
    expect(vm.id).toMatch(/^vm-/);
    expect(r.egress.policies.has(vm.address)).toBe(false);
    const st = AgentState.parse(r.agent.state());
    expect(st.runtime).toBe("microvm");
    expect(st.microvm?.uid).toBe(10002);
    expect(st.harness.probeVms).toMatchObject([
      { id: vm.id, address: vm.address },
    ]);
    // The fake Docker lists it under its container id; give it the VM's id, as the VM driver would.
    const c = [...r.docker.containers.values()][0]!;
    r.docker.containers.delete(c.id);
    r.docker.containers.set(vm.id, { ...c, id: vm.id });
    r.clock.advance(60_000 - 1);
    await r.agent.reconcile();
    expect(r.docker.containers.has(vm.id)).toBe(true);
    await r.agent.syncEgress();
    expect(r.egress.policies.has(vm.address)).toBe(false);

    const out = await r.agent.runProbe(vm.id, {
      targets: [{ name: "metadata", host: "169.254.169.254", port: 80 }],
    });
    expect(out.results).toEqual([{ name: "metadata", result: "timeout" }]);
    await expect(
      r.agent.runProbe("vm-nope", {
        targets: [{ name: "x", host: "1.1.1.1", port: 1 }],
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await r.agent.removeProbeVm(vm.id)).toBe(true);
    expect(r.docker.containers.has(vm.id)).toBe(false);
    expect(r.agent.state().harness.probeVms).toEqual([]);
  });

  it("are removed at their deadline", async () => {
    const ref: { rig?: ReturnType<typeof makeRig> } = {};
    const r = (ref.rig = makeRig(
      { poolTarget: 0 },
      { harness: true, microvm: vmHooks(() => ref.rig!) },
    ));
    await r.agent.boot();
    const vm = await r.agent.makeProbeVm(5_000);
    const c = [...r.docker.containers.values()][0]!;
    r.docker.containers.delete(c.id);
    r.docker.containers.set(vm.id, { ...c, id: vm.id });
    r.clock.advance(6_000);
    r.agent.tick();
    await r.agent.idle();
    expect(r.docker.containers.has(vm.id)).toBe(false);
    expect(r.agent.state().harness.probeVms).toEqual([]);
  });
});

describe("the harness socket", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
  });

  const call = (
    socketPath: string,
    method: string,
    path: string,
    body?: unknown,
    secret: string | null = "s3cret",
  ) =>
    new Promise<{ status: number; json: Record<string, unknown> }>(
      (resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = request(
          {
            socketPath,
            method,
            path,
            headers: {
              ...(secret ? { authorization: `Bearer ${secret}` } : {}),
              "content-type": "application/json",
            },
          },
          (res) => {
            let t = "";
            res.on("data", (c: Buffer) => (t += c.toString()));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(t) }),
            );
          },
        );
        req.on("error", reject);
        req.end(data);
      },
    );

  it("is owner-only, wants the node secret, and validates what it is sent", async () => {
    const r = makeRig({}, { harness: true });
    await r.agent.boot();
    const sock = join(mkdtempSync("/tmp/hs-"), "harness.sock");
    const server = createHarnessServer(r.agent, "s3cret", log);
    await listenHarness(server, sock);
    closers.push(() => server.close());
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const lease = `${HARNESS_PATHS.probePolicy}/172.30.1.90`;
    expect(
      (await call(sock, "PUT", lease, { ttlMs: 60_000 }, null)).status,
    ).toBe(401);
    expect((await call(sock, "PUT", lease, { ttlMs: 1 })).status).toBe(400);
    const ok = await call(sock, "PUT", lease, { ttlMs: 60_000 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ip: "172.30.1.90" });
    expect(
      (
        await call(sock, "PUT", `${HARNESS_PATHS.probePolicy}/172.30.1.1`, {
          ttlMs: 60_000,
        })
      ).status,
    ).toBe(409);
    expect((await call(sock, "DELETE", lease)).json).toEqual({
      released: true,
    });
    expect(
      (await call(sock, "POST", HARNESS_PATHS.probeVm, { ttlMs: 60_000 }))
        .status,
    ).toBe(409); // not a microVM node
    expect(
      (await call(sock, "DELETE", `${HARNESS_PATHS.probeVm}/not-an-id`)).status,
    ).toBe(400);
  });
});
