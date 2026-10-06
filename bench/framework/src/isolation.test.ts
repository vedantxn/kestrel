import { describe, expect, it } from "vitest";
import { judge, rawTargets, type RawTarget } from "./isolation.js";

const base = {
  bridgeIp: "172.30.1.1",
  publicIp: "3.3.3.3",
  testHost: "kestrel-testpage.s3.amazonaws.com",
  otherBridges: ["172.30.2.1"],
  neighbours: ["172.30.1.140"],
};

describe("the isolation suite's raw targets (G-06, G-23)", () => {
  it("aims at the same things from a container and from a VM, and more from a VM", () => {
    const c = rawTargets({ ...base, from: "container" });
    const v = rawTargets({ ...base, from: "vm", self: "172.30.1.131" });
    const names = (t: RawTarget[]) => t.map((x) => x.name);
    for (const must of [
      "raw connection to 169.254.169.254:80 (the cloud metadata service)",
      "raw connection to 172.30.1.1:7001 (the node agent)",
      "raw connection to 172.30.1.140:9223 (another session's CDP port)",
      "raw connection to 172.30.2.1:3128 (another node's egress gateway)",
      "DNS query to 169.254.169.253:53 (the VPC's resolver at its link-local address)",
    ]) {
      expect(names(c)).toContain(must);
      expect(names(v)).toContain(must);
    }
    // Only a VM has a namespace of its own between it and the bridge.
    expect(names(v)).toContain(
      "raw connection to 172.16.0.1:9000 (the VM's namespace)",
    );
    expect(names(v)).toContain(
      "raw connection to 172.30.1.131:9000 (its own control port, from inside (hairpin))",
    );
    expect(names(c).some((n) => n.includes("172.16.0.1"))).toBe(false);
    // Each has exactly one positive control: its way to the egress gateway.
    const ctl = (t: RawTarget[]) => t.filter((x) => x.expect === "connected");
    expect(ctl(c).map((x) => `${x.host}:${x.port}`)).toEqual([
      "172.30.1.1:3128",
    ]);
    expect(ctl(v).map((x) => `${x.host}:${x.port}`)).toEqual([
      "172.16.0.1:3128",
    ]);
    // Names are unique: results are matched by name.
    expect(new Set(names(v)).size).toBe(v.length);
    expect(v.length).toBeLessThanOrEqual(64);
  });

  it("judges each attempt by what must come of it", () => {
    const refuse: RawTarget = {
      name: "x",
      host: "169.254.169.254",
      port: 80,
      proto: "tcp",
      expect: "refused",
    };
    expect(judge(refuse, { result: "timeout" }).pass).toBe(true);
    expect(judge(refuse, { result: "ECONNREFUSED" }).pass).toBe(true);
    expect(judge(refuse, { result: "connected" }).pass).toBe(false);
    expect(
      judge({ ...refuse, proto: "udp-dns" }, { result: "answered" }).pass,
    ).toBe(false);
    expect(judge(refuse, undefined).pass).toBe(false);
    const ctl: RawTarget = { ...refuse, expect: "connected" };
    expect(judge(ctl, { result: "connected" }).pass).toBe(true);
    expect(judge(ctl, { result: "timeout" }).pass).toBe(false);
    const deny: RawTarget = { ...refuse, expect: "denied", send: "CONNECT" };
    expect(
      judge(deny, {
        result: "connected",
        head: "HTTP/1.1 403 Forbidden",
        denied: "no_policy",
      }).pass,
    ).toBe(true);
    expect(
      judge(deny, {
        result: "connected",
        head: "HTTP/1.1 200 Connection established",
      }).pass,
    ).toBe(false);
  });
});
