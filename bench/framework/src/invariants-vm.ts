/**
 * H5 for microVM nodes (ADR 0017, threat model G-25). What the invariant checker reads for a VM,
 * and the rules it applies: the same questions as for a container ("is it hardened", "is anything
 * leaked"), asked of jails, cgroups, processes and network namespaces instead of `docker inspect`.
 * Pure functions over what `collect-vm.ts` reads from the host, so every rule is tested to fire
 * on its own fault.
 */

/** A process as the host sees it (`/proc/<pid>`). */
export interface VmProcess {
  pid: number;
  /** Real and effective ids. */
  uid: [number, number];
  gid: [number, number];
  /** Effective capabilities, as /proc prints them (hex). */
  capEff: string | null;
  /** `Seccomp:` from /proc/<pid>/status: 2 is a filter. */
  seccomp: number | null;
  noNewPrivs: boolean | null;
  /** The cgroup v2 path, from /proc/<pid>/cgroup. */
  cgroup: string | null;
  /** Namespace links (`pid:[...]`, `mnt:[...]`, `net:[...]`). */
  pidNs: string | null;
  mntNs: string | null;
  netNs: string | null;
  /** The device and inode of the process's root directory (through /proc/<pid>/root). */
  root: { dev: number; ino: number } | null;
}

export interface MicroVmView {
  id: string;
  /** The agent's record of the VM (its meta file), if there is one. */
  meta: {
    node: string | null;
    role: string | null;
    creation: string | null;
    octet: number | null;
    handlerPid: number | null;
  } | null;
  /** The jail directory exists, and the device and inode of its root (what the VMM's root must be). */
  jail: { root: { dev: number; ino: number } | null } | null;
  vmm: VmProcess | null;
  handler: VmProcess | null;
  cgroup: {
    cpuMax: string | null;
    memoryMax: string | null;
    swapMax: string | null;
    pidsMax: string | null;
  } | null;
}

export interface VmNetns {
  name: string;
  octet: number;
  /** `iptables-save` inside the namespace; null if it could not be read. */
  rules: string | null;
  ipv6Disabled: boolean | null;
  /** `net:[inode]`, to match a VMM's own namespace. */
  netNs: string | null;
}

export interface VmHostView {
  node: string;
  dir: string;
  cgroupParent: string;
  bridgeIp: string;
  egressPort: number;
  uid: number;
  gid: number;
  vcpus: number;
  memMib: number;
  pages: "2M" | "4K";
  /** The agent's namespaces by last octet: made and waiting, used, being made. */
  agentNetns: { ready: number[]; inUse: number[]; making: number[] };
  netnsTarget: number;
  vms: MicroVmView[];
  netns: VmNetns[];
  /** Octets of this node's host-side veths (`kv<node><octet>`). */
  veths: number[];
  /** Directories under the cgroup parent that are no VM's (a template build left them, say). */
  strayCgroups: string[];
  /** Jail directories that are no VM's. */
  strayJails: string[];
  hostPidNs: string | null;
  hostMntNs: string | null;
}

export interface HugePages {
  sizeKb: number;
  total: number;
  free: number;
  reserved: number;
}

/** What a VM must be (ADR 0017); fixed here, like the container profile, not read from the agent. */
export const VM_POLICY = {
  uid: 10002,
  /** cpu.max per vCPU: the guest's vCPU plus room for the VMM's own work. */
  cpuPerVcpu: 2,
  vcpus: 1,
  memoryMaxBytes: (2048 + 256) * 1024 * 1024,
  pidsMax: 64,
} as const;

/** The guest's side of every clone (the snapshot holds it; `apps/node/src/microvm.ts` GUEST). */
export const GUEST = {
  ip: "172.16.0.2",
  gateway: "172.16.0.1",
  proxyPort: 3128,
  ports: [9000, 9223],
} as const;

export interface AgentVmAccount {
  node: string;
  /** Every id the agent owns: bindings, pool, retiring, probe VMs. */
  ids: Set<string>;
  creating: Set<string>;
  /** Bindings whose browser is a VM, with their state. */
  bindings: { sessionId: string; state: string; containerId: string }[];
  pool: string[];
}

const CAP_NONE = /^0+$/;
const strip32 = (a: string) => a.replace(/\/32$/, "");

/** One `-A` rule, by its flags. Negations and unknown shapes are kept so they can be refused. */
export function parseRule(line: string): {
  chain: string;
  flags: Map<string, string>;
  negated: boolean;
} {
  const toks = line.match(/"[^"]*"|\S+/g) ?? [];
  const flags = new Map<string, string>();
  let negated = false;
  let chain = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "!") {
      negated = true;
      continue;
    }
    if (!t.startsWith("-")) continue;
    const next = toks[i + 1];
    const value = next !== undefined && !next.startsWith("-") ? next : "";
    if (t === "-A") chain = value;
    else if (t === "-m") flags.set(`-m ${value}`, value);
    else flags.set(t, value);
    if (value) i++;
  }
  return { chain, flags, negated };
}

/**
 * The namespace's packet rules (`iptables-save` inside it) against what isolates a VM: nothing in
 * but the control and CDP flows to the guest, nothing out but the guest's proxy flow to this
 * node's egress gateway, and every other path dropped. Judged by meaning, not text, so iptables'
 * own spellings (`-m tcp`, `RELATED,ESTABLISHED`, `/32`) do not matter. Anything not recognisably
 * one of the allowed rules is a problem.
 */
export function checkNetnsRules(
  text: string,
  c: { bridgeIp: string; egressPort: number },
): string[] {
  const problems: string[] = [];
  const tables = new Map<string, string[]>();
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("*")) {
      table = line.slice(1);
      tables.set(table, []);
    } else if (line !== "COMMIT") tables.get(table)?.push(line);
  }
  const filter = tables.get("filter");
  if (!filter) return ["no filter table: every path is open"];
  const policy = (chain: string): string | undefined =>
    filter.find((l) => l.startsWith(`:${chain} `))?.split(" ")[1];
  for (const chain of ["INPUT", "FORWARD"])
    if (policy(chain) !== "DROP")
      problems.push(
        `${chain} policy is ${policy(chain) ?? "missing"}, not DROP`,
      );
  const ports = (f: Map<string, string>): number[] =>
    (f.get("--dports") ?? f.get("--dport") ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
  const only = (f: Map<string, string>, allowed: string[]) =>
    [...f.keys()].every((k) => allowed.includes(k));

  for (const line of filter.filter((l) => l.startsWith("-A "))) {
    const { chain, flags: f, negated } = parseRule(line);
    const target = f.get("-j") ?? "";
    if (["DROP", "REJECT"].includes(target)) continue;
    if (target === "RETURN" && chain !== "INPUT" && chain !== "FORWARD")
      continue;
    if (chain === "OUTPUT") continue; // the namespace's own traffic: it makes none
    if (target !== "ACCEPT") {
      problems.push(`unexpected rule: ${line}`);
      continue;
    }
    if (negated) {
      problems.push(`a negated accept: ${line}`);
      continue;
    }
    if (chain === "INPUT") {
      if (!(f.get("-i") === "lo" && only(f, ["-i", "-j"])))
        problems.push(`INPUT accepts more than loopback: ${line}`);
      continue;
    }
    if (chain !== "FORWARD") {
      problems.push(`accept in chain ${chain}: ${line}`);
      continue;
    }
    const states = (f.get("--ctstate") ?? f.get("--state") ?? "")
      .split(",")
      .filter(Boolean);
    const replies =
      states.length > 0 &&
      states.every((s) => s === "ESTABLISHED" || s === "RELATED");
    if (replies) continue;
    const inbound =
      f.get("-i") === "eth0" &&
      f.get("-o") === "tap0" &&
      strip32(f.get("-d") ?? "") === GUEST.ip &&
      f.get("-p") === "tcp" &&
      ports(f).length > 0 &&
      ports(f).every((p) => (GUEST.ports as readonly number[]).includes(p));
    const outbound =
      f.get("-i") === "tap0" &&
      f.get("-o") === "eth0" &&
      strip32(f.get("-s") ?? "") === GUEST.ip &&
      strip32(f.get("-d") ?? "") === c.bridgeIp &&
      f.get("-p") === "tcp" &&
      ports(f).length === 1 &&
      ports(f)[0] === c.egressPort;
    if (!inbound && !outbound)
      problems.push(`FORWARD accepts a path it must not: ${line}`);
  }

  for (const line of (tables.get("nat") ?? []).filter((l) =>
    l.startsWith("-A "),
  )) {
    const { chain, flags: f } = parseRule(line);
    const target = f.get("-j") ?? "";
    if (target !== "DNAT" && target !== "REDIRECT") continue;
    const to = f.get("--to-destination") ?? "";
    const control =
      chain === "PREROUTING" &&
      f.get("-i") === "eth0" &&
      f.get("-p") === "tcp" &&
      ports(f).length > 0 &&
      ports(f).every((p) => (GUEST.ports as readonly number[]).includes(p)) &&
      to === GUEST.ip;
    const proxy =
      chain === "PREROUTING" &&
      f.get("-i") === "tap0" &&
      strip32(f.get("-d") ?? "") === GUEST.gateway &&
      f.get("-p") === "tcp" &&
      ports(f).length === 1 &&
      ports(f)[0] === GUEST.proxyPort &&
      to === `${c.bridgeIp}:${c.egressPort}`;
    if (!control && !proxy)
      problems.push(`a redirection it must not have: ${line}`);
  }
  return problems;
}

const sameId = (
  a: { dev: number; ino: number } | null,
  b: { dev: number; ino: number } | null,
) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** cpu.max as a share of one CPU, or Infinity for "max". */
function cpuShare(v: string | null): number {
  const [q, p] = (v ?? "").trim().split(/\s+/);
  if (q === "max" || !q || !p) return Number.POSITIVE_INFINITY;
  return Number(q) / Number(p);
}

export function checkVms(
  hosts: VmHostView[],
  accounts: AgentVmAccount[],
  hugepages: HugePages | null | undefined,
  bad: (rule: string, detail: string) => void,
): void {
  const owned = new Set(accounts.flatMap((a) => [...a.ids]));
  const creating = new Set(accounts.flatMap((a) => [...a.creating]));
  const short = (id: string) => id.slice(0, 15);
  let liveVms = 0;

  for (const h of hosts) {
    const live = new Map(
      h.vms.filter((v) => v.vmm !== null).map((v) => [v.id, v]),
    );
    liveVms += live.size;
    const nsByOctet = new Map(h.netns.map((n) => [n.octet, n]));

    // 1. Every VM, and every piece of one, belongs to an agent (or is being made by one).
    for (const v of h.vms) {
      const mine =
        owned.has(v.id) ||
        (v.meta?.creation != null && creating.has(v.meta.creation));
      if (mine) continue;
      const parts = [
        v.vmm && `a VMM (pid ${v.vmm.pid})`,
        v.handler && `a page-fault handler (pid ${v.handler.pid})`,
        v.jail && "a jail",
        v.cgroup && "a cgroup",
        v.meta && "an agent record",
      ].filter(Boolean);
      bad(
        "leaked-vm",
        `${short(v.id)} (${v.meta?.role ?? "?"}) has ${parts.join(", ")} but no agent holds it`,
      );
    }
    for (const id of h.strayCgroups)
      bad(
        "leaked-vm-resource",
        `node ${h.node}: cgroup ${h.cgroupParent}/${id} is no VM's`,
      );
    for (const id of h.strayJails)
      bad("leaked-vm-resource", `node ${h.node}: jail ${id} is no VM's`);
    for (const v of h.vms)
      if (v.handler && !v.vmm)
        bad(
          "leaked-vm-resource",
          `${short(v.id)}: its page-fault handler (pid ${v.handler.pid}) outlived its VMM`,
        );

    // 2. Namespaces, and their veths, are the agent's: ready, in use, or being made.
    const known = new Set([
      ...h.agentNetns.ready,
      ...h.agentNetns.inUse,
      ...h.agentNetns.making,
    ]);
    for (const n of h.netns)
      if (!known.has(n.octet))
        bad(
          "leaked-vm-resource",
          `node ${h.node}: network namespace ${n.name} is not the agent's`,
        );
    for (const o of h.veths)
      if (!known.has(o) && !nsByOctet.has(o))
        bad(
          "leaked-vm-resource",
          `node ${h.node}: veth for .${o} has no namespace`,
        );
    if (h.agentNetns.ready.length > h.netnsTarget)
      bad(
        "leaked-vm-resource",
        `node ${h.node}: ${h.agentNetns.ready.length} namespaces made ahead, more than ${h.netnsTarget}`,
      );

    // 3. Every namespace isolates its guest, and has no IPv6.
    for (const n of h.netns) {
      if (n.rules === null) {
        bad("vm-netns-rules", `${n.name}: its rules could not be read`);
        continue;
      }
      for (const p of checkNetnsRules(n.rules, h))
        bad("vm-netns-rules", `${n.name}: ${p}`);
      if (n.ipv6Disabled !== true)
        bad("vm-netns-rules", `${n.name}: IPv6 is not disabled`);
    }

    // 4. Every running VM carries the hardened profile (the jailer's chroot, user, cgroup, namespaces).
    for (const v of live.values()) {
      const w = (what: string) =>
        bad(
          "vm-not-hardened",
          `${short(v.id)} (${v.meta?.role ?? "?"}): ${what}`,
        );
      const p = v.vmm!;
      if (p.uid[0] !== VM_POLICY.uid || p.uid[1] !== VM_POLICY.uid)
        w(`its VMM runs as uid ${p.uid.join("/")}`);
      if (p.gid[0] === 0 || p.gid[1] === 0) w("its VMM runs with group 0");
      if (p.capEff === null || !CAP_NONE.test(p.capEff))
        w(`its VMM has capabilities ${p.capEff ?? "(unreadable)"}`);
      if (p.seccomp !== 2) w(`its VMM has no seccomp filter (${p.seccomp})`);
      if (p.noNewPrivs !== true) w("its VMM may gain privileges");
      if (p.pidNs === null || p.pidNs === h.hostPidNs)
        w("its VMM is in the host's PID namespace");
      if (p.mntNs === null || p.mntNs === h.hostMntNs)
        w("its VMM is in the host's mount namespace");
      if (!sameId(p.root, v.jail?.root ?? null))
        w("its VMM's root is not its jail");
      const octet = v.meta?.octet ?? null;
      const ns = octet === null ? undefined : nsByOctet.get(octet);
      if (!ns || p.netNs === null || p.netNs !== ns.netNs)
        w("its VMM is not in its own network namespace");
      const cg = `/${h.cgroupParent}/${v.id}`;
      if (p.cgroup !== cg) w(`its VMM is in cgroup ${p.cgroup}, not ${cg}`);
      if (!v.cgroup) w("it has no cgroup");
      else {
        const share = cpuShare(v.cgroup.cpuMax);
        if (share > VM_POLICY.cpuPerVcpu * VM_POLICY.vcpus)
          w(`its CPU limit is ${v.cgroup.cpuMax}`);
        if (Number(v.cgroup.memoryMax) !== VM_POLICY.memoryMaxBytes)
          w(`its memory limit is ${v.cgroup.memoryMax}`);
        if (v.cgroup.swapMax?.trim() !== "0")
          w(`it may swap (${v.cgroup.swapMax})`);
        const pids = Number(v.cgroup.pidsMax);
        if (!Number.isFinite(pids) || pids > VM_POLICY.pidsMax)
          w(`its process limit is ${v.cgroup.pidsMax}`);
      }
      if (h.pages === "2M") {
        const hd = v.handler;
        if (!hd) w("its page-fault handler is gone");
        else {
          if (hd.uid[0] !== VM_POLICY.uid || hd.uid[1] !== VM_POLICY.uid)
            w(`its page-fault handler runs as uid ${hd.uid.join("/")}`);
          if (hd.capEff === null || !CAP_NONE.test(hd.capEff))
            w(`its page-fault handler has capabilities ${hd.capEff}`);
          if (hd.cgroup !== cg)
            w(`its page-fault handler is in cgroup ${hd.cgroup}`);
        }
      }
    }

    // 5. What the agents hold as VMs is running.
    for (const a of accounts) {
      if (a.node !== h.node) continue;
      for (const b of a.bindings)
        if (b.state === "ready" && !live.has(b.containerId))
          bad(
            "vm-not-running",
            `${b.sessionId} is ready on ${h.node} but its VM ${short(b.containerId)} is not running`,
          );
      for (const id of a.pool)
        if (!live.has(id))
          bad(
            "vm-not-running",
            `pooled VM ${short(id)} on ${h.node} is not running`,
          );
    }
  }

  // 6. Huge pages: nothing holds any beyond what the running VMs can use.
  if (hugepages && hosts.some((h) => h.pages === "2M")) {
    const perVm = Math.ceil(
      (Math.max(...hosts.map((h) => h.memMib)) * 1024) / hugepages.sizeKb,
    );
    const held = hugepages.total - hugepages.free + hugepages.reserved;
    if (held > liveVms * perVm)
      bad(
        "leaked-hugepages",
        `${held} huge pages are in use or reserved, more than ${liveVms} running VM(s) can hold (${liveVms * perVm})`,
      );
  }
}
