import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
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
  const lines: string[] = [];
  server = new ControlServer(
    policies,
    denials,
    createEgressMetrics(),
    createLogger(
      "t",
      "info",
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    ),
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
  return { path, policies, denials, call, logged: () => lines.join("") };
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
    const first = await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), body);
    expect(first).toEqual({
      status: 200,
      json: { sessionId: ses, upstream: false },
    });
    expect(
      (await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), body)).status,
    ).toBe(200);
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

  it("acknowledges an upstream proxy and never lists its password (T-45, T-47)", async () => {
    const { call, policies } = await rig();
    const password = "pr0xy-s3cret";
    const put = await call("PUT", EGRESS_PATHS.policy("172.30.1.7"), {
      sessionId: ses,
      upstream: {
        host: "proxy.example.com",
        port: 3128,
        username: "u",
        password,
      },
    });
    expect(put).toEqual({
      status: 200,
      json: { sessionId: ses, upstream: true },
    });
    const listed = await call("GET", EGRESS_PATHS.policies);
    expect(JSON.stringify(listed.json)).not.toContain(password);
    const auth = policies.get("172.30.1.7")!.upstream!.authorization!;
    expect(JSON.stringify(listed.json)).not.toContain(auth.slice(6));
    expect(
      ListPoliciesResponse.parse(listed.json).policies[0]?.upstream,
    ).toEqual({ host: "proxy.example.com", port: 3128, username: "u" });
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe(
      `u:${password}`,
    );
  });

  it("refuses a malformed upstream, and never echoes the body it could not parse", async () => {
    const { call, policies, path, logged } = await rig();
    for (const upstream of [
      { host: "Proxy.Example.com", port: 3128 },
      { host: "::1", port: 3128 },
      { host: "proxy.example.com", port: 0 },
      { host: "proxy.example.com", port: 3128, username: "a:b" },
      { host: "proxy.example.com", port: 3128, extra: 1 },
    ])
      expect(
        (
          await call("PUT", EGRESS_PATHS.policy("172.30.1.8"), {
            sessionId: ses,
            upstream,
          })
        ).status,
      ).toBe(400);
    expect(policies.size).toBe(0);
    const truncated = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const r = request(
          {
            socketPath: path,
            method: "PUT",
            path: EGRESS_PATHS.policy("172.30.1.8"),
          },
          (res) => {
            let text = "";
            res.on("data", (d) => (text += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        r.on("error", reject);
        r.end('{"sessionId":"x","upstream":{"password":"leak-me');
      },
    );
    expect(truncated.status).toBe(400);
    expect(truncated.text).not.toContain("leak-me");
    expect(logged()).not.toContain("leak-me");
    expect(logged()).toContain("invalid JSON");
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
      (
        await call("PUT", EGRESS_PATHS.policy("172.30.1.5"), {
          sessionId: ses,
          upstream: { host: "proxy.example.com", port: 3128, extra: 1 },
        })
      ).status,
    ).toBe(400);
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
