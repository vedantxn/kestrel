import { execFile } from "node:child_process";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MicroVmRuntimeView } from "@kestrel/contracts";
import type {
  HugePages,
  MicroVmView,
  VmHostView,
  VmNetns,
  VmProcess,
} from "./invariants-vm.js";

/**
 * Fill the microVM part of an invariant snapshot from the host (G-25). Everything is read from
 * the host itself, not asked of the agent: processes from /proc, limits from the cgroup tree,
 * jails and the agent's records from the VM directory, packet rules from inside each namespace.
 * The agent says only where to look (its `/v1/state` layout) and what it believes it holds.
 *
 * The harness container needs the host's PID and cgroup namespaces, /run/netns, the VM directory
 * and enough privilege to read other users' /proc entries and enter namespaces
 * (`infra/host/bench.sh` runs it so).
 */
export interface HostReader {
  readFile(path: string): Promise<string | null>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string | null>;
  stat(path: string): Promise<{ dev: number; ino: number } | null>;
  /** stdout, or null if the command failed. */
  exec(cmd: string, args: string[]): Promise<string | null>;
}

export const realHost: HostReader = {
  readFile: (p) => readFile(p, "utf8").catch(() => null),
  readdir: (p) => readdir(p).catch(() => []),
  readlink: (p) => readlink(p).catch(() => null),
  stat: (p) =>
    stat(p).then(
      (s) => ({ dev: s.dev, ino: s.ino }),
      () => null,
    ),
  exec: (cmd, args) =>
    new Promise((resolve) =>
      execFile(
        cmd,
        args,
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
        (e, out) => resolve(e ? null : String(out)),
      ),
    ),
};

const VM_ID = /^vm-[0-9a-f]{24}$/;

export interface HostProcess {
  pid: number;
  argv: string[];
}

/** Every process on the host with its command line. */
export async function listProcesses(h: HostReader): Promise<HostProcess[]> {
  const out: HostProcess[] = [];
  for (const d of await h.readdir("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const cmd = await h.readFile(`/proc/${d}/cmdline`);
    if (!cmd) continue;
    out.push({ pid: Number(d), argv: cmd.split("\0").filter(Boolean) });
  }
  return out;
}

/** The VM a process belongs to: its Firecracker (`--id <vm>`), or its page-fault handler. */
export function classify(
  p: HostProcess,
): { id: string; kind: "vmm" | "handler" } | null {
  const i = p.argv.indexOf("--id");
  const id = i >= 0 ? p.argv[i + 1] : undefined;
  if (id && VM_ID.test(id) && p.argv.some((a) => a.includes("firecracker")))
    return { id, kind: "vmm" };
  for (const a of p.argv) {
    const m = /\/jail\/firecracker\/(vm-[0-9a-f]{24})\/root\/uffd\.sock$/.exec(
      a,
    );
    if (m) return { id: m[1]!, kind: "handler" };
  }
  return null;
}

const field = (status: string, name: string): string | null =>
  new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1]?.trim() ?? null;
const pair = (v: string | null): [number, number] => {
  const [r, e] = (v ?? "").split(/\s+/).map(Number);
  return [r ?? -1, e ?? -1];
};

export async function readProcess(
  h: HostReader,
  pid: number,
): Promise<VmProcess | null> {
  const status = await h.readFile(`/proc/${pid}/status`);
  if (!status) return null;
  const cg = await h.readFile(`/proc/${pid}/cgroup`);
  const seccomp = field(status, "Seccomp");
  const nnp = field(status, "NoNewPrivs");
  return {
    pid,
    uid: pair(field(status, "Uid")),
    gid: pair(field(status, "Gid")),
    capEff: field(status, "CapEff"),
    seccomp: seccomp === null ? null : Number(seccomp),
    noNewPrivs: nnp === null ? null : nnp === "1",
    cgroup:
      cg
        ?.split("\n")
        .find((l) => l.startsWith("0::"))
        ?.slice(3)
        .trim() ?? null,
    pidNs: await h.readlink(`/proc/${pid}/ns/pid`),
    mntNs: await h.readlink(`/proc/${pid}/ns/mnt`),
    netNs: await h.readlink(`/proc/${pid}/ns/net`),
    // Through the magic link: the directory the process sees as its root.
    root: await h.stat(`/proc/${pid}/root/`),
  };
}

interface Meta {
  id: string;
  octet?: number;
  labels?: Record<string, string>;
  handlerPid?: number;
}

export async function readHugePages(h: HostReader): Promise<HugePages | null> {
  const d = "/sys/kernel/mm/hugepages/hugepages-2048kB";
  const n = async (f: string) => Number((await h.readFile(join(d, f)))?.trim());
  const total = await n("nr_hugepages");
  if (!Number.isFinite(total)) return null;
  return {
    sizeKb: 2048,
    total,
    free: await n("free_hugepages"),
    reserved: await n("resv_hugepages"),
  };
}

/**
 * Every microVM node's VMs, namespaces and leftovers. Nodes that share a VM directory share its
 * jails and cgroups: a piece that names no node is shown under the first of them.
 */
export async function collectVmHosts(
  h: HostReader,
  nodes: { node: string; layout: MicroVmRuntimeView }[],
): Promise<VmHostView[]> {
  if (nodes.length === 0) return [];
  const procs = await listProcesses(h);
  const byVm = new Map<string, { vmm?: number; handler?: number }>();
  for (const p of procs) {
    const c = classify(p);
    if (!c) continue;
    const e = byVm.get(c.id) ?? {};
    e[c.kind] = p.pid;
    byVm.set(c.id, e);
  }
  const hostPidNs = await h.readlink("/proc/1/ns/pid");
  const hostMntNs = await h.readlink("/proc/1/ns/mnt");
  const netnsNames = await h.readdir("/run/netns");
  const links = await h.readdir("/sys/class/net");
  // The agents' records, read first: a piece whose record names a node is that node's.
  const metasOf = new Map<string, Map<string, Meta>>();
  const recorded = new Set<string>();
  for (const { node, layout } of nodes) {
    const metas = new Map<string, Meta>();
    for (const f of await h.readdir(join(layout.dir, "meta"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(
          (await h.readFile(join(layout.dir, "meta", f))) ?? "",
        ) as Meta;
        if (VM_ID.test(m.id) && m.labels?.["kestrel.node"] === node) {
          metas.set(m.id, m);
          recorded.add(m.id);
        }
      } catch {
        /* half-written: it shows up as a jail or process without a record */
      }
    }
    metasOf.set(node, metas);
  }
  const out: VmHostView[] = [];

  for (const [i, { node, layout }] of nodes.entries()) {
    const first = nodes.findIndex((n) => n.layout.dir === layout.dir) === i;
    const metas = metasOf.get(node) ?? new Map<string, Meta>();
    const jailDir = join(layout.dir, "jail", "firecracker");
    const jails = await h.readdir(jailDir);
    const cgroupDir = join("/sys/fs/cgroup", layout.cgroupParent);
    const cgroups = (await h.readdir(cgroupDir)).filter(
      (n) => !n.includes("."),
    );
    const ids = new Set<string>(metas.keys());
    if (first)
      for (const id of [...jails, ...cgroups, ...byVm.keys()])
        if (VM_ID.test(id) && !recorded.has(id)) ids.add(id);

    const vms: MicroVmView[] = [];
    for (const id of ids) {
      const m = metas.get(id);
      const procsOf = byVm.get(id) ?? {};
      const hasJail = jails.includes(id);
      const hasCgroup = cgroups.includes(id);
      const cg = async (f: string) =>
        (await h.readFile(join(cgroupDir, id, f)))?.trim() ?? null;
      vms.push({
        id,
        meta: m
          ? {
              node: m.labels?.["kestrel.node"] ?? null,
              role: m.labels?.["kestrel.role"] ?? null,
              creation: m.labels?.["kestrel.creation"] ?? null,
              octet: typeof m.octet === "number" ? m.octet : null,
              handlerPid:
                typeof m.handlerPid === "number" ? m.handlerPid : null,
            }
          : null,
        jail: hasJail
          ? { root: await h.stat(join(jailDir, id, "root")) }
          : null,
        vmm:
          procsOf.vmm === undefined ? null : await readProcess(h, procsOf.vmm),
        handler:
          procsOf.handler === undefined
            ? null
            : await readProcess(h, procsOf.handler),
        cgroup: hasCgroup
          ? {
              cpuMax: await cg("cpu.max"),
              memoryMax: await cg("memory.max"),
              swapMax: await cg("memory.swap.max"),
              pidsMax: await cg("pids.max"),
            }
          : null,
      });
    }

    const prefix = `kvm-${node}-`;
    const netns: VmNetns[] = [];
    for (const name of netnsNames) {
      if (!name.startsWith(prefix)) continue;
      const octet = Number(name.slice(prefix.length));
      if (!Number.isInteger(octet)) continue;
      const path = `/run/netns/${name}`;
      const st = await h.stat(path);
      const ipv6 = await h.exec("nsenter", [
        `--net=${path}`,
        "cat",
        "/proc/sys/net/ipv6/conf/all/disable_ipv6",
      ]);
      netns.push({
        name,
        octet,
        rules: await h.exec("nsenter", [`--net=${path}`, "iptables-save"]),
        ipv6Disabled: ipv6 === null ? null : ipv6.trim() === "1",
        netNs: st ? `net:[${st.ino}]` : null,
      });
    }
    const vethPrefix = `kv${node}`;
    const veths = links
      .filter((l) => l.startsWith(vethPrefix))
      .map((l) => Number(l.slice(vethPrefix.length)))
      .filter(
        (o) =>
          Number.isInteger(o) && o >= layout.octets[0] && o <= layout.octets[1],
      );

    out.push({
      node,
      dir: layout.dir,
      cgroupParent: layout.cgroupParent,
      bridgeIp: layout.bridgeIp,
      egressPort: layout.egressPort,
      uid: layout.uid,
      gid: layout.gid,
      vcpus: layout.vcpus,
      memMib: layout.memMib,
      pages: layout.pages,
      agentNetns: layout.netns,
      netnsTarget: layout.netnsTarget,
      vms,
      netns,
      veths,
      strayCgroups: first ? cgroups.filter((c) => !VM_ID.test(c)) : [],
      strayJails: first ? jails.filter((j) => !VM_ID.test(j)) : [],
      hostPidNs,
      hostMntNs,
    });
  }
  return out;
}
