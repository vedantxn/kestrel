import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  type DockerContainer,
  type Snapshot,
} from "./invariants.js";
import { finish, makeReport, renderMarkdown } from "./report.js";
import { percentile, summarize } from "./stats.js";

describe("statistics", () => {
  it("uses nearest-rank percentiles", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
    expect(summarize([3, 1, 2])).toMatchObject({
      n: 3,
      min: 1,
      p50: 2,
      max: 3,
      mean: 2,
    });
  });
});

describe("reports (H6)", () => {
  it("fails with no checks, passes only if every check passes, and renders", () => {
    const empty = makeReport("m1", { host: "x" });
    expect(empty.build().pass).toBe(false);
    const r = makeReport("m1", { host: "x", slots: 12 });
    r.add({ id: "1", name: "sequential", pass: true, detail: "0 failures" });
    r.add({
      id: "6",
      name: "latency",
      pass: false,
      detail: "p50 | 200 ms > 150 ms",
    });
    r.measure("create", { p50: 12.34 });
    const built = r.build();
    expect(built.pass).toBe(false);
    const md = renderMarkdown(built);
    expect(md).toContain("**FAIL**");
    expect(md).toContain("p50 \\| 200 ms");
    expect(md).toContain("slots: 12");
  });

  it("writes JSON and Markdown, prints one JSON line, and returns the exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    const r = makeReport("exit check", { host: "x" });
    r.add({ id: "1", name: "a", pass: true, detail: "ok" });
    const lines: string[] = [];
    expect(finish(r.build(), dir, (l) => lines.push(l))).toBe(0);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!);
    expect(out).toMatchObject({ name: "exit check", pass: true, failed: [] });
    expect(existsSync(out.report)).toBe(true);
    expect(existsSync(out.report.replace(/\.json$/, ".md"))).toBe(true);
    expect(JSON.parse(readFileSync(out.report, "utf8")).pass).toBe(true);
    const f = makeReport("bad", {});
    f.add({ id: "2", name: "b", pass: false, detail: "no" });
    expect(finish(f.build(), dir, () => undefined)).toBe(1);
  });
});

const hardened = (id: string, role = "session"): DockerContainer => ({
  id,
  node: "a",
  role,
  running: true,
  address: "172.30.1.5",
  config: {
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    readonlyRootfs: true,
    user: "10001:10001",
    pidsLimit: 1024,
    memory: 2048 * 1024 * 1024,
    memorySwap: 2048 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    tmpfs: {
      "/profile": "rw,noexec,nosuid,nodev,size=512m",
      "/tmp": "rw,noexec,nosuid,nodev,size=64m",
    },
    ports: 0,
    binds: 0,
    networkMode: "ksl-a",
    noNewPrivileges: true,
  },
});

/** A healthy host: one ready session, one pooled browser. */
function good(): Snapshot {
  const c1 = "c1".padEnd(64, "0");
  const c2 = "c2".padEnd(64, "0");
  return {
    docker: [hardened(c1), hardened(c2, "pool")],
    api: [
      { id: "ses_1", status: "ready", nodeId: "a", ageSeconds: 5 },
      { id: "ses_0", status: "stopped", nodeId: "a", ageSeconds: 500 },
    ],
    agents: [
      {
        node: "a",
        slotsTotal: 4,
        sessions: [
          {
            sessionId: "ses_1",
            state: "ready",
            address: "172.30.1.5",
            containerId: c1,
          },
        ],
        pool: [{ containerId: c2, address: "172.30.1.6" }],
        pendingReports: 0,
      },
    ],
    egress: [
      {
        node: "a",
        policies: [{ ip: "172.30.1.5", sessionId: "ses_1" }],
        policiesRestored: true,
      },
    ],
    gateways: [{ node: "a", routes: ["ses_1"], attachments: [] }],
    firewall: [{ node: "a", ok: true, problems: [] }],
    failpoints: [{ process: "api", active: {} }],
    failpointsExpected: false,
  };
}
const rules = (s: Snapshot) => checkInvariants(s).map((v) => v.rule);

describe("the invariant checker (H5)", () => {
  it("finds nothing wrong with a healthy host", () => {
    expect(checkInvariants(good())).toEqual([]);
  });

  it("finds a session the API has but no agent holds, and the reverse", () => {
    const a = good();
    a.api.push({ id: "ses_9", status: "ready", nodeId: "a", ageSeconds: 1 });
    expect(rules(a)).toEqual(["api-session-without-binding"]);
    const b = good();
    b.api = b.api.filter((x) => x.id !== "ses_1");
    expect(rules(b)).toContain("binding-without-api-session");
  });

  it("finds sessions stuck stopping or starting", () => {
    const a = good();
    a.api.push({
      id: "ses_8",
      status: "stopping",
      nodeId: "a",
      ageSeconds: 45,
    });
    expect(rules(a)).toEqual(["stuck-stopping"]);
    const b = good();
    b.api.push({
      id: "ses_7",
      status: "starting",
      nodeId: "a",
      ageSeconds: 90,
    });
    expect(rules(b)).toContain("stuck-starting");
  });

  it("finds a leaked container, and a binding or pooled browser whose container is gone", () => {
    const a = good();
    a.docker.push(hardened("leak".padEnd(64, "0")));
    expect(rules(a)).toEqual(["leaked-container"]);
    const b = good();
    b.docker = b.docker.filter((c) => c.role !== "session");
    expect(rules(b)).toContain("binding-without-container");
    const c = good();
    c.docker = c.docker.filter((x) => x.role !== "pool");
    expect(rules(c)).toContain("pool-without-container");
  });

  it("finds egress policies that leaked, that belong to the wrong session, or that are missing", () => {
    const a = good();
    a.egress[0]!.policies.push({ ip: "172.30.1.99", sessionId: "ses_0" });
    expect(rules(a)).toEqual(["leaked-egress-policy"]);
    const b = good();
    b.egress[0]!.policies = [{ ip: "172.30.1.5", sessionId: "ses_other" }];
    expect(rules(b)).toContain("egress-policy-wrong-session");
    const c = good();
    c.egress[0]!.policies = [];
    expect(rules(c)).toContain("ready-session-without-policy");
    const d = good();
    d.egress[0]!.policiesRestored = false;
    expect(rules(d)).toContain("egress-not-restored");
  });

  it("a pooled browser must have no policy", () => {
    const a = good();
    a.egress[0]!.policies.push({ ip: "172.30.1.6", sessionId: "ses_1" });
    expect(rules(a)).toContain("leaked-egress-policy");
  });

  it("finds routes that leaked or are missing, and attachments to nothing", () => {
    const a = good();
    a.gateways[0]!.routes = ["ses_1", "ses_0"];
    expect(rules(a)).toEqual(["leaked-route"]);
    const b = good();
    b.gateways[0]!.routes = [];
    expect(rules(b)).toEqual(["ready-session-without-route"]);
    const c = good();
    c.gateways[0]!.attachments = [{ sessionId: "ses_0", connections: 1 }];
    expect(rules(c)).toEqual(["attachment-without-session"]);
    const d = good();
    d.gateways[0]!.routes = null; // a gateway that cannot list its routes is not judged on them
    expect(checkInvariants(d)).toEqual([]);
  });

  it("finds oversubscribed slots and a report backlog", () => {
    const a = good();
    a.agents[0]!.slotsTotal = 1;
    expect(rules(a)).toEqual(["pool-over-slots"]);
    const b = good();
    b.agents[0]!.pendingReports = 3;
    expect(rules(b)).toEqual(["report-backlog"]);
  });

  it("finds firewall drift, and failpoints left on outside a test run", () => {
    const a = good();
    a.firewall[0] = { node: "a", ok: false, problems: ["chain missing"] };
    expect(rules(a)).toEqual(["firewall-drift"]);
    const b = good();
    b.failpoints[0]!.active = { "api.node_stop": "drop" };
    expect(rules(b)).toEqual(["failpoints-active"]);
    b.failpointsExpected = true;
    expect(checkInvariants(b)).toEqual([]);
  });

  describe("hardening (G-05)", () => {
    const weaken = (f: (c: DockerContainer["config"]) => void) => {
      const s = good();
      f(s.docker[0]!.config);
      return rules(s);
    };
    it("fails each weakening, and only that", () => {
      for (const [name, f] of [
        ["privileged", (c: DockerContainer["config"]) => (c.privileged = true)],
        [
          "a capability added",
          (c: DockerContainer["config"]) => (c.capAdd = ["NET_ADMIN"]),
        ],
        [
          "capabilities not dropped",
          (c: DockerContainer["config"]) => (c.capDrop = []),
        ],
        [
          "no-new-privileges off",
          (c: DockerContainer["config"]) => (c.noNewPrivileges = false),
        ],
        [
          "writable root",
          (c: DockerContainer["config"]) => (c.readonlyRootfs = false),
        ],
        ["root user", (c: DockerContainer["config"]) => (c.user = "")],
        [
          "no pids limit",
          (c: DockerContainer["config"]) => (c.pidsLimit = null),
        ],
        [
          "bigger memory",
          (c: DockerContainer["config"]) => (c.memory = 4096 * 1024 * 1024),
        ],
        [
          "swap",
          (c: DockerContainer["config"]) =>
            (c.memorySwap = (c.memory ?? 0) * 2),
        ],
        [
          "more CPU",
          (c: DockerContainer["config"]) => (c.nanoCpus = 2_000_000_000),
        ],
        [
          "exec tmpfs",
          (c: DockerContainer["config"]) =>
            (c.tmpfs = { "/profile": "rw,size=512m" }),
        ],
        ["published ports", (c: DockerContainer["config"]) => (c.ports = 1)],
        ["host mount", (c: DockerContainer["config"]) => (c.binds = 1)],
        [
          "wrong network",
          (c: DockerContainer["config"]) => (c.networkMode = "bridge"),
        ],
      ] as const) {
        expect(weaken(f), name).toContain("container-not-hardened");
      }
    });
  });
});

describe("the harness races and the harness surface", () => {
  it("does not count a container an agent is still making, nor one it is removing", () => {
    const a = good();
    a.docker.push({
      ...hardened("mk".padEnd(64, "0"), "pool"),
      creation: "n1",
    });
    expect(rules(a)).toEqual(["leaked-container"]);
    a.agents[0]!.creating = ["n1"];
    expect(checkInvariants(a)).toEqual([]);
    const b = good();
    b.docker.push(hardened("rm".padEnd(64, "0"), "pool"));
    b.agents[0]!.retiring = ["rm".padEnd(64, "0")];
    expect(checkInvariants(b)).toEqual([]);
  });

  it("lets a probe's lease own its policy, but never lets a probe be left behind", () => {
    const a = good();
    a.egress[0]!.policies.push({ ip: "172.30.1.90", sessionId: "ses_probe" });
    expect(rules(a)).toEqual(["leaked-egress-policy"]);
    a.agents[0]!.harness = {
      enabled: true,
      probePolicies: [{ ip: "172.30.1.90", sessionId: "ses_probe" }],
      probeVms: [],
    };
    a.harnessExpected = true;
    expect(rules(a)).toEqual(["harness-probe-left"]);
    a.agents[0]!.harness.probePolicies[0]!.sessionId = "ses_other";
    expect(rules(a)).toEqual(["leaked-egress-policy", "harness-probe-left"]);
  });

  it("finds the harness surface on outside a harness run", () => {
    const a = good();
    a.agents[0]!.harness = { enabled: true, probePolicies: [], probeVms: [] };
    expect(rules(a)).toEqual(["harness-surface-on"]);
    a.harnessExpected = true;
    expect(checkInvariants(a)).toEqual([]);
  });
});
