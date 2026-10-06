import { describe, expect, it } from "vitest";
import {
  AgentState,
  ProbePolicyRequest,
  ProbeRequest,
  ProbeResponse,
  RekeyRequest,
} from "./index.js";

describe("the harness surface", () => {
  it("reads an agent's state from before the harness fields, with safe defaults", () => {
    const s = AgentState.parse({
      sessions: [],
      pool: [],
      pendingReports: 0,
      slotsTotal: 4,
      admitting: true,
      failpoints: {},
    });
    expect(s).toMatchObject({
      runtime: "docker",
      creating: [],
      retiring: [],
      harness: { enabled: false, probePolicies: [], probeVms: [] },
    });
  });

  it("bounds a probe lease's life", () => {
    expect(ProbePolicyRequest.safeParse({ ttlMs: 60_000 }).success).toBe(true);
    expect(ProbePolicyRequest.safeParse({ ttlMs: 3_600_000 }).success).toBe(
      false,
    );
    expect(ProbePolicyRequest.safeParse({ ttlMs: 10, x: 1 }).success).toBe(
      false,
    );
  });
});

describe("probes from a guest (G-23)", () => {
  it("rekeys as a probe only with the literal flag", () => {
    const token = "a".repeat(32);
    expect(RekeyRequest.safeParse({ token, probe: true }).success).toBe(true);
    expect(RekeyRequest.safeParse({ token, probe: false }).success).toBe(false);
    expect(RekeyRequest.safeParse({ token }).success).toBe(true);
  });

  it("takes address literals only, and a bounded number of targets", () => {
    const t = { name: "x", host: "169.254.169.254", port: 80 };
    expect(ProbeRequest.parse({ targets: [t] }).targets[0]).toMatchObject({
      proto: "tcp",
      timeoutMs: 3000,
    });
    expect(
      ProbeRequest.safeParse({ targets: [{ ...t, host: "example.com" }] })
        .success,
    ).toBe(false);
    expect(
      ProbeRequest.safeParse({ targets: [{ ...t, host: "::ffff:a9fe:a9fe" }] })
        .success,
    ).toBe(true);
    expect(
      ProbeRequest.safeParse({ targets: Array.from({ length: 65 }, () => t) })
        .success,
    ).toBe(false);
  });

  it("refuses a guest's answer that is too big or has extra fields", () => {
    expect(
      ProbeResponse.safeParse({
        results: [{ name: "x", result: "timeout", extra: 1 }],
      }).success,
    ).toBe(false);
    expect(
      ProbeResponse.safeParse({
        results: [{ name: "x", result: "connected", head: "h".repeat(600) }],
      }).success,
    ).toBe(false);
  });
});
