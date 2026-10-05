import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DenialsResponse,
  EGRESS_PATHS,
  EgressHealth,
  ListPoliciesResponse,
  newId,
} from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ControlServer } from "./control.js";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";

let server: ControlServer | undefined;
afterEach(async () => server?.close());

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  const path = join(dir, "egress.sock");
  const policies = new PolicyStore();
  const denials = new DenialLog();
  server = new ControlServer(
    policies,
    denials,
    createEgressMetrics(),
    createLogger("t", "silent"),
  );
  await server.listen(path);
  const call = (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
      const r = request(
        {
          socketPath: path,
          method,
          path: url,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              json: text ? JSON.parse(text) : undefined,
            }),
          );
        },
      );
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { path, policies, denials, call };
}

const ses = newId("ses");

describe("the control API (C7)", () => {
  it("is reachable only through a socket the agent owns (mode 0600)", async () => {
    const { path } = await rig();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("starts empty and says so: it refuses everything until the agent restores policies (N13)", async () => {
    const { call, policies } = await rig();
    const h = EgressHealth.parse((await call("GET", EGRESS_PATHS.health)).json);
    expect(h).toEqual({
      status: "ok",
      policiesRestored: false,
      policyCount: 0,
    });
    await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), { sessionId: ses });
    expect(policies.restored).toBe(false);
    await call("POST", EGRESS_PATHS.restored);
    expect(
      EgressHealth.parse((await call("GET", EGRESS_PATHS.health)).json),
    ).toEqual({ status: "ok", policiesRestored: true, policyCount: 1 });
  });

  it("sets, lists and clears policies idempotently", async () => {
    const { call } = await rig();
    const body = {
      sessionId: ses,
      allow: ["example.com"],
      deny: ["*.ads.test"],
      connectionCap: 10,
    };
    expect(
      (await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), body)).status,
    ).toBe(204);
    expect(
      (await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), body)).status,
    ).toBe(204);
    const list = ListPoliciesResponse.parse(
      (await call("GET", EGRESS_PATHS.policies)).json,
    );
    expect(list.policies).toEqual([
      {
        ip: "172.30.1.5",
        sessionId: ses,
        allow: ["example.com"],
        deny: ["*.ads.test"],
        connectionCap: 10,
        openConnections: 0,
      },
    ]);
    expect(
      (await call("DELETE", EGRESS_PATHS.policy("172.30.1.5"))).status,
    ).toBe(204);
    expect(
      (await call("DELETE", EGRESS_PATHS.policy("172.30.1.5"))).status,
    ).toBe(204);
    expect(
      ListPoliciesResponse.parse(
        (await call("GET", EGRESS_PATHS.policies)).json,
      ).policies,
    ).toEqual([]);
  });

  it("applies the default connection cap", async () => {
    const { call } = await rig();
    await call("PUT", EGRESS_PATHS.policy("172.30.1.6"), { sessionId: ses });
    const list = ListPoliciesResponse.parse(
      (await call("GET", EGRESS_PATHS.policies)).json,
    );
    expect(list.policies[0]?.connectionCap).toBe(256);
  });

  it("rejects bad input", async () => {
    const { call } = await rig();
    expect(
      (
        await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), {
          sessionId: "nope",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), {
          sessionId: ses,
          allow: ["not a host"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), {
          sessionId: ses,
          unknown: 1,
        })
      ).status,
    ).toBe(400); // unknown fields are refused, never dropped (T-47)
    expect(
      (await call("PUT", "/v1/policies/not-an-ip", { sessionId: ses })).status,
    ).toBe(404);
    expect(
      (await call("PUT", "/v1/policies/999.1.1.1", { sessionId: ses })).status,
    ).toBe(404);
    expect((await call("GET", "/nothing")).status).toBe(404);
    expect((await call("GET", `${EGRESS_PATHS.denials}?after=-1`)).status).toBe(
      400,
    );
  });

  it("serves denials after a sequence number, with an epoch that identifies this process", async () => {
    const { call, denials } = await rig();
    denials.add({
      sessionId: ses,
      host: "169.254.169.254",
      port: 80,
      reason: "blocked_address",
    });
    denials.add({
      sessionId: ses,
      host: "10.0.0.1",
      port: 443,
      reason: "blocked_address",
    });
    const all = DenialsResponse.parse(
      (await call("GET", EGRESS_PATHS.denials)).json,
    );
    expect(all.epoch).toBe(denials.epoch);
    expect(all.denials.map((d) => d.host)).toEqual([
      "169.254.169.254",
      "10.0.0.1",
    ]);
    const next = DenialsResponse.parse(
      (
        await call(
          "GET",
          `${EGRESS_PATHS.denials}?after=${all.denials[0]!.seq}`,
        )
      ).json,
    );
    expect(next.denials.map((d) => d.host)).toEqual(["10.0.0.1"]);
  });

  it("replaces a stale socket file left by a crashed process", async () => {
    const r = await rig();
    await server!.close();
    const again = new ControlServer(
      r.policies,
      r.denials,
      createEgressMetrics(),
      createLogger("t", "silent"),
    );
    await again.listen(r.path);
    server = again;
    expect((await r.call("GET", EGRESS_PATHS.health)).status).toBe(200);
  });
});
