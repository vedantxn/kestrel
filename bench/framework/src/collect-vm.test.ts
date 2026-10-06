import type { MicroVmRuntimeView } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import {
  classify,
  collectVmHosts,
  readHugePages,
  readProcess,
  type HostReader,
} from "./collect-vm.js";
import { checkInvariants, type Snapshot } from "./invariants.js";
import { GOOD_RULES } from "./fixtures.test-data.js";

const VM = "vm-" + "1".repeat(24);
const DIR = "/data/kestrel-vm";

/** A host as /proc, cgroupfs, the VM directory and the namespaces show it. */
function fakeHost(): {
  h: HostReader;
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  links: Map<string, string>;
  stats: Map<string, { dev: number; ino: number }>;
  execs: Map<string, string>;
} {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const links = new Map<string, string>();
  const stats = new Map<string, { dev: number; ino: number }>();
  const execs = new Map<string, string>();
  const status = (uid: number, seccomp: number, nnp: number) =>
    [
      `Name:\tx`,
      `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`,
      `Gid:\t${uid}\t${uid}\t${uid}\t${uid}`,
      `CapEff:\t0000000000000000`,
      `NoNewPrivs:\t${nnp}`,
      `Seccomp:\t${seccomp}`,
    ].join("\n");
  dirs.set("/proc", ["1", "500", "501", "777", "self"]);
  files.set(
    "/proc/500/cmdline",
    [
      "/firecracker",
      "--id",
      VM,
      "--api-sock",
      "/run/firecracker.socket",
      "",
    ].join("\0"),
  );
  files.set(
    "/proc/501/cmdline",
    [
      "/opt/firecracker/uffd_on_demand_handler",
      `${DIR}/jail/firecracker/${VM}/root/uffd.sock`,
      `${DIR}/jail/firecracker/${VM}/root/mem`,
    ].join("\0"),
  );
  files.set("/proc/777/cmdline", "node\0apps/node/dist/main.js");
  files.set("/proc/500/status", status(10002, 2, 1));
  files.set("/proc/501/status", status(10002, 0, 0));
  for (const p of ["500", "501"])
    files.set(`/proc/${p}/cgroup`, `0::/kestrel-vm/${VM}\n`);
  links.set("/proc/1/ns/pid", "pid:[4026531836]");
  links.set("/proc/1/ns/mnt", "mnt:[4026531841]");
  links.set("/proc/500/ns/pid", "pid:[4026532001]");
  links.set("/proc/500/ns/mnt", "mnt:[4026532002]");
  links.set("/proc/500/ns/net", "net:[4026532130]");
  stats.set("/proc/500/root/", { dev: 66306, ino: 1001 });
  stats.set(`${DIR}/jail/firecracker/${VM}/root`, { dev: 66306, ino: 1001 });
  dirs.set(`${DIR}/meta`, [`${VM}.json`]);
  files.set(
    `${DIR}/meta/${VM}.json`,
    JSON.stringify({
      id: VM,
      octet: 130,
      labels: {
        "kestrel.node": "a",
        "kestrel.role": "session",
        "kestrel.creation": "c1",
      },
      createdAt: 1,
      handlerPid: 501,
    }),
  );
  dirs.set(`${DIR}/jail/firecracker`, [VM]);
  dirs.set("/sys/fs/cgroup/kestrel-vm", [
    "cgroup.procs",
    "cpu.max",
    VM,
    "memory.max",
  ]);
  const cg = `/sys/fs/cgroup/kestrel-vm/${VM}`;
  files.set(`${cg}/cpu.max`, "200000 100000\n");
  files.set(`${cg}/memory.max`, `${(2048 + 256) * 1024 * 1024}\n`);
  files.set(`${cg}/memory.swap.max`, "0\n");
  files.set(`${cg}/pids.max`, "64\n");
  dirs.set("/run/netns", ["kvm-a-130", "kvm-a-131", "kvm-tpl", "kvm-b-130"]);
  stats.set("/run/netns/kvm-a-130", { dev: 4, ino: 4026532130 });
  stats.set("/run/netns/kvm-a-131", { dev: 4, ino: 4026532131 });
  for (const o of [130, 131]) {
    execs.set(`nsenter --net=/run/netns/kvm-a-${o} iptables-save`, GOOD_RULES);
    execs.set(
      `nsenter --net=/run/netns/kvm-a-${o} cat /proc/sys/net/ipv6/conf/all/disable_ipv6`,
      "1\n",
    );
  }
  dirs.set("/sys/class/net", [
    "lo",
    "ens5",
    "ksl-a",
    "kva130",
    "kva131",
    "kvb7",
  ]);
  const hp = "/sys/kernel/mm/hugepages/hugepages-2048kB";
  files.set(`${hp}/nr_hugepages`, "7000\n");
  files.set(`${hp}/free_hugepages`, "6000\n");
  files.set(`${hp}/resv_hugepages`, "20\n");
  const h: HostReader = {
    readFile: async (p) => files.get(p) ?? null,
    readdir: async (p) => dirs.get(p) ?? [],
    readlink: async (p) => links.get(p) ?? null,
    stat: async (p) => stats.get(p) ?? null,
    exec: async (cmd, args) => execs.get([cmd, ...args].join(" ")) ?? null,
  };
  return { h, files, dirs, links, stats, execs };
}

const layout: MicroVmRuntimeView = {
  dir: DIR,
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
  netns: { ready: [131], inUse: [130], making: [] },
};

describe("reading microVMs from the host (G-25)", () => {
  it("tells a VM's Firecracker and its handler from everything else", () => {
    expect(
      classify({ pid: 1, argv: ["/firecracker", "--id", VM, "--x"] }),
    ).toEqual({ id: VM, kind: "vmm" });
    expect(
      classify({
        pid: 2,
        argv: ["h", `${DIR}/jail/firecracker/${VM}/root/uffd.sock`],
      }),
    ).toEqual({ id: VM, kind: "handler" });
    expect(classify({ pid: 3, argv: ["node", "--id", VM] })).toBeNull();
    expect(
      classify({ pid: 4, argv: ["/firecracker", "--id", "tpl-1"] }),
    ).toBeNull();
  });

  it("reads a process's ids, capabilities, filter, cgroup and namespaces", async () => {
    const { h } = fakeHost();
    expect(await readProcess(h, 500)).toEqual({
      pid: 500,
      uid: [10002, 10002],
      gid: [10002, 10002],
      capEff: "0000000000000000",
      seccomp: 2,
      noNewPrivs: true,
      cgroup: `/kestrel-vm/${VM}`,
      pidNs: "pid:[4026532001]",
      mntNs: "mnt:[4026532002]",
      netNs: "net:[4026532130]",
      root: { dev: 66306, ino: 1001 },
    });
    expect(await readProcess(h, 4242)).toBeNull();
    expect(await readHugePages(h)).toEqual({
      sizeKb: 2048,
      total: 7000,
      free: 6000,
      reserved: 20,
    });
  });

  it("collects a healthy node that the rules pass, and finds what is left behind", async () => {
    const host = fakeHost();
    const [view] = await collectVmHosts(host.h, [{ node: "a", layout }]);
    expect(view!.vms.map((v) => v.id)).toEqual([VM]);
    expect(view!.netns.map((n) => n.name)).toEqual(["kvm-a-130", "kvm-a-131"]);
    expect(view!.veths).toEqual([130, 131]);
    const pages = await readHugePages(host.h);
    const snap = (vms: Snapshot["vms"]): Snapshot => ({
      docker: [],
      api: [{ id: "ses_1", status: "ready", nodeId: "a", ageSeconds: 1 }],
      agents: [
        {
          node: "a",
          slotsTotal: 4,
          sessions: [
            {
              sessionId: "ses_1",
              state: "ready",
              address: "172.30.1.130",
              containerId: VM,
            },
          ],
          pool: [],
          pendingReports: 0,
        },
      ],
      egress: [
        {
          node: "a",
          policies: [{ ip: "172.30.1.130", sessionId: "ses_1" }],
          policiesRestored: true,
        },
      ],
      gateways: [],
      firewall: [],
      failpoints: [],
      failpointsExpected: false,
      vms,
      hugepages: pages,
    });
    expect(checkInvariants(snap([view!]))).toEqual([]);

    // The session ended but its jail, cgroup and namespace stayed.
    host.dirs.set("/proc", ["1", "777"]);
    host.dirs.set(`${DIR}/meta`, []);
    const [after] = await collectVmHosts(host.h, [
      {
        node: "a",
        layout: { ...layout, netns: { ready: [131], inUse: [], making: [] } },
      },
    ]);
    const s = snap([after!]);
    s.agents[0]!.sessions = [];
    s.api = [];
    s.egress[0]!.policies = [];
    s.hugepages = { sizeKb: 2048, total: 7000, free: 7000, reserved: 0 };
    expect(
      checkInvariants(s)
        .map((v) => v.rule)
        .sort(),
    ).toEqual(["leaked-vm", "leaked-vm-resource"]);
  });
});
