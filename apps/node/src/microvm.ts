import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type Docker from "dockerode";
import {
  RekeyResponse,
  RUNTIME_PATHS,
  RUNTIME_PORTS,
  RuntimeHealth,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import type { ContainerInfo, DockerDriver, DockerEvent } from "./docker.js";

/**
 * The microVM runtime (V7, ADR 0017): a session's browser is a Firecracker VM restored from a
 * snapshot of a browser that was already running, instead of a new Docker container. Restoring
 * takes about 130 ms where a container and Chrome take about 1.5 s, and no daemon serializes the
 * work, so making and removing browsers no longer slow each other down.
 *
 * Each VM runs under Firecracker's jailer: its own chroot, an unprivileged user, a cgroup with the
 * session's CPU and memory, and its own network namespace. Every clone has the same guest address
 * (it is in the snapshot); the namespace gives it a unique one on the node's bridge, so the egress
 * gateway's source-address identity, the firewall chain and the bridge's isolation all apply as
 * they do to a container (ADR 0003, 0005).
 *
 * The VM is presented to the agent through the same driver interface as a container. Its id starts
 * with `vm-`; what the agent would read from Docker (labels, address, creation time) is kept in a
 * file the VM cannot reach, beside the jailer's directories.
 */
export interface MicroVmConfig {
  nodeId: string;
  firecracker: string;
  jailer: string;
  /** Holds `template/` (vmstate, mem, rootfs.ext4, token), `jail/` and `meta/`; one filesystem, for hard links. */
  dir: string;
  /** cgroup v2 parent, relative to the cgroup root; its controllers must be enabled. */
  cgroupParent: string;
  /** The node's session bridge (its interface name), its address, and the egress gateway's port. */
  bridge: string;
  bridgeIp: string;
  egressPort: number;
  /** The first three octets of the bridge's subnet, and the last octets VMs may use. */
  subnetPrefix: string;
  octets: [number, number];
  vmUid: number;
  vmGid: number;
  /** Network namespaces kept made ahead of need. */
  netnsReady: number;
  vcpus: number;
  memMib: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  input?: string,
) => Promise<string>;

export const exec: Exec = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) =>
      err
        ? reject(
            new Error(
              `${cmd} ${args.slice(0, 3).join(" ")}: ${stderr.trim() || err.message}`,
            ),
          )
        : resolve(stdout),
    );
    if (input !== undefined) p.stdin?.end(input);
  });

/** The guest's address and its gateway, the same in every clone (the snapshot holds them). */
export const GUEST = {
  ip: "172.16.0.2",
  gateway: "172.16.0.1",
  proxyPort: 3128,
};

interface Meta {
  id: string;
  octet: number;
  labels: Record<string, string>;
  createdAt: number;
}

/**
 * Network namespaces for VMs, made ahead of need: making one is about a dozen `ip` and
 * `iptables` calls (~250 ms), which would otherwise sit on every start. A namespace is used by one
 * VM and then deleted, never reused, so nothing (connection tracking included) carries over.
 */
export class NetnsPool {
  private ready: number[] = [];
  private inUse = new Set<number>();
  private making = new Set<number>();
  private filling: Promise<void> | null = null;

  constructor(
    private readonly c: MicroVmConfig,
    private readonly run: Exec,
    private readonly log: Logger,
  ) {}

  name(octet: number): string {
    return `kvm-${this.c.nodeId}-${octet}`;
  }
  address(octet: number): string {
    return `${this.c.subnetPrefix}.${octet}`;
  }
  /** Locally administered, from the address: 02:4b:00:<subnet's 2nd and 3rd octets>:<octet>. */
  mac(octet: number): string {
    const h = (n: number) => n.toString(16).padStart(2, "0");
    const [, b, c] = this.c.subnetPrefix.split(".").map(Number) as [
      number,
      number,
      number,
    ];
    return `02:4b:00:${h(b)}:${h(c)}:${h(octet)}`;
  }

  /** At boot: namespaces of live VMs stay in use; any other of this node's is deleted. */
  async recover(live: number[]): Promise<void> {
    for (const o of live) this.inUse.add(o);
    const out = await this.run("ip", ["netns", "list"]).catch(() => "");
    const prefix = `kvm-${this.c.nodeId}-`;
    for (const line of out.split("\n")) {
      const n = line.split(" ")[0] ?? "";
      if (!n.startsWith(prefix)) continue;
      const o = Number(n.slice(prefix.length));
      if (!this.inUse.has(o)) await this.drop(o);
    }
  }

  async take(): Promise<number> {
    const o = this.ready.shift() ?? (await this.make());
    this.inUse.add(o);
    void this.fill();
    return o;
  }

  async release(octet: number): Promise<void> {
    if (!this.inUse.delete(octet) && !this.ready.includes(octet)) return;
    this.ready = this.ready.filter((o) => o !== octet);
    await this.drop(octet);
    void this.fill();
  }

  fill(): Promise<void> {
    if (this.filling) return this.filling;
    this.filling = (async () => {
      try {
        while (this.ready.length + this.making.size < this.c.netnsReady) {
          const o = await this.make();
          this.ready.push(o);
        }
      } catch (e) {
        this.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "microvm: could not make a network namespace",
        );
      } finally {
        this.filling = null;
      }
    })();
    return this.filling;
  }

  private free(): number {
    for (let o = this.c.octets[0]; o <= this.c.octets[1]; o++)
      if (!this.inUse.has(o) && !this.making.has(o) && !this.ready.includes(o))
        return o;
    throw new Error("no address left for a microVM");
  }

  private async make(): Promise<number> {
    const o = this.free();
    this.making.add(o);
    const ns = this.name(o);
    const hv = `kv${this.c.nodeId}${o}`;
    const c = this.c;
    try {
      await this.drop(o); // a leftover of a crash
      await this.run(
        "sh",
        ["-e"],
        [
          `ip netns add ${ns}`,
          // A fixed MAC per address: a namespace is made afresh for each VM, and a new MAC behind a
          // reused address left the host sending to the old one until its ARP entry expired.
          `ip link add ${hv} type veth peer name eth0 address ${this.mac(o)} netns ${ns}`,
          `ip link set ${hv} master ${c.bridge}`,
          `ip link set ${hv} up`,
          `ip -n ${ns} link set lo up`,
          `ip -n ${ns} addr add ${this.address(o)}/24 dev eth0`,
          `ip -n ${ns} link set eth0 up`,
          `ip -n ${ns} route add default via ${c.bridgeIp}`,
          `ip -n ${ns} tuntap add tap0 mode tap user ${c.vmUid} group ${c.vmGid}`,
          `ip -n ${ns} addr add ${GUEST.gateway}/24 dev tap0`,
          `ip -n ${ns} link set tap0 up`,
          `ip netns exec ${ns} sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward"`,
          `ip netns exec ${ns} sh -c "echo 1 > /proc/sys/net/ipv6/conf/all/disable_ipv6"`,
          `ip netns exec ${ns} iptables-restore <<'RULES'`,
          // In: only the agent's control API and the gateway's CDP forward reach the guest.
          // Out: only the guest's proxy address, sent to this node's egress gateway, leaves, and it
          // leaves as this namespace's address: the egress gateway's identity for the session (ADR 0005).
          "*nat",
          ":PREROUTING ACCEPT [0:0]",
          ":POSTROUTING ACCEPT [0:0]",
          `-A PREROUTING -i eth0 -p tcp -m multiport --dports ${RUNTIME_PORTS.control},${RUNTIME_PORTS.cdpForward} -j DNAT --to-destination ${GUEST.ip}`,
          `-A PREROUTING -i tap0 -d ${GUEST.gateway} -p tcp --dport ${GUEST.proxyPort} -j DNAT --to-destination ${c.bridgeIp}:${c.egressPort}`,
          "-A POSTROUTING -o eth0 -j MASQUERADE",
          "-A POSTROUTING -o tap0 -j MASQUERADE",
          "COMMIT",
          "*filter",
          ":INPUT DROP [0:0]",
          ":FORWARD DROP [0:0]",
          ":OUTPUT ACCEPT [0:0]",
          "-A INPUT -i lo -j ACCEPT",
          "-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
          `-A FORWARD -i eth0 -o tap0 -d ${GUEST.ip} -p tcp -m multiport --dports ${RUNTIME_PORTS.control},${RUNTIME_PORTS.cdpForward} -m conntrack --ctstate NEW -j ACCEPT`,
          `-A FORWARD -i tap0 -o eth0 -s ${GUEST.ip} -d ${c.bridgeIp} -p tcp --dport ${c.egressPort} -m conntrack --ctstate NEW -j ACCEPT`,
          "COMMIT",
          "RULES",
        ].join("\n") + "\n",
      );
      return o;
    } catch (e) {
      await this.drop(o);
      throw e;
    } finally {
      this.making.delete(o);
    }
  }

  private async drop(octet: number): Promise<void> {
    await this.run("ip", ["netns", "del", this.name(octet)]).catch(
      () => undefined,
    );
    await this.run("ip", [
      "neigh",
      "del",
      this.address(octet),
      "dev",
      this.c.bridge,
    ]).catch(() => undefined);
    await this.run("ip", ["link", "del", `kv${this.c.nodeId}${octet}`]).catch(
      () => undefined,
    );
  }
}

/** One HTTP call over a unix socket (Firecracker's API). */
function unixCall(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: {
          "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          if (text.length < 4096) text += c.toString();
        });
        res.on("end", () =>
          (res.statusCode ?? 500) < 300
            ? resolve()
            : reject(
                new Error(
                  `firecracker ${path}: ${res.statusCode} ${text.slice(0, 200)}`,
                ),
              ),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`firecracker ${path}: timed out`)),
    );
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The host's processes, as the driver sees them (replaceable in tests). */
export interface Procs {
  /** Is `pid` the Firecracker of VM `id`? (The pid file is in the VM's chroot, so it is checked.) */
  isVmm(pid: number, id: string): Promise<boolean>;
  alive(pid: number): boolean;
  kill(pid: number): void;
}

export const hostProcs: Procs = {
  isVmm: async (pid, id) => {
    const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    return cmd.split("\0").includes(id) && cmd.includes("firecracker");
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  },
};

export interface MicroVmDeps {
  run: Exec;
  log: Logger;
  /** The runtime's control API, for the restore's health check and rekey (overridable in tests). */
  fetch?: typeof fetch;
  procs?: Procs;
}

export class MicroVmDriver implements DockerDriver {
  readonly netns: NetnsPool;
  private removing = new Set<string>();
  private dead = new Set<string>();
  private listeners = new Set<(e: DockerEvent) => void>();
  private watch: NodeJS.Timeout | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly procs: Procs;

  constructor(
    private readonly c: MicroVmConfig,
    private readonly d: MicroVmDeps,
  ) {
    this.netns = new NetnsPool(c, d.run, d.log);
    this.fetchFn = d.fetch ?? fetch;
    this.procs = d.procs ?? hostProcs;
  }

  private get jail(): string {
    return join(this.c.dir, "jail", "firecracker");
  }
  private root(id: string): string {
    return join(this.jail, id, "root");
  }
  private metaPath(id: string): string {
    return join(this.c.dir, "meta", `${id}.json`);
  }

  /** Before the agent's boot: namespaces of VMs that are still running stay, the rest go. */
  async start(): Promise<void> {
    await mkdir(join(this.c.dir, "meta"), { recursive: true, mode: 0o700 });
    await mkdir(this.jail, { recursive: true });
    const live: number[] = [];
    for (const m of await this.metas()) {
      if (await this.pid(m.id).then((p) => p !== null && this.procs.alive(p)))
        live.push(m.octet);
    }
    await this.netns.recover(live);
    void this.netns.fill();
    // A VM's VMM exiting is its container dying: told to the agent as Docker would.
    this.watch = setInterval(() => void this.poll(), 500);
    this.watch.unref();
  }

  stop(): void {
    clearInterval(this.watch);
  }

  /** Read at every restore: a rebuilt template has a new token (and the old clones keep theirs). */
  private async token(): Promise<string> {
    return (
      await readFile(join(this.c.dir, "template", "token"), "utf8")
    ).trim();
  }

  private async metas(): Promise<Meta[]> {
    const dir = join(this.c.dir, "meta");
    const out: Meta[] = [];
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Meta);
      } catch {
        /* a half-written file from a crash: reconciliation removes the VM */
      }
    }
    return out.filter((m) => m.labels["kestrel.node"] === this.c.nodeId);
  }

  private async pid(id: string): Promise<number | null> {
    // Written by the jailer inside the chroot, which the VMM can write to: trusted only to name a
    // process that is this VM's Firecracker (its command line carries the VM's id).
    const raw = await readFile(
      join(this.root(id), "firecracker.pid"),
      "utf8",
    ).catch(() => "");
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return (await this.procs.isVmm(pid, id)) ? pid : null;
  }

  private info(m: Meta, running: boolean): ContainerInfo {
    return {
      id: m.id,
      labels: m.labels,
      running,
      address: this.netns.address(m.octet),
      oomKilled: false,
      exitCode: running ? null : 137,
      createdAt: m.createdAt,
    };
  }

  async run(spec: Docker.ContainerCreateOptions): Promise<ContainerInfo> {
    const env = new Map(
      (spec.Env ?? []).map((e) => [
        e.slice(0, e.indexOf("=")),
        e.slice(e.indexOf("=") + 1),
      ]),
    );
    const token = env.get("KESTREL_CONTROL_TOKEN");
    if (!token) throw new Error("microvm: no control token in the spec");
    const id = `vm-${randomBytes(12).toString("hex")}`;
    const t0 = performance.now();
    const marks: Record<string, number> = {};
    const mark = (k: string) => (marks[k] = Math.round(performance.now() - t0));
    const octet = await this.netns.take();
    mark("netns");
    const meta: Meta = {
      id,
      octet,
      labels: (spec.Labels ?? {}) as Record<string, string>,
      createdAt: Date.now(),
    };
    try {
      await writeFile(this.metaPath(id), JSON.stringify(meta), { mode: 0o600 });
      await this.restore(id, octet, mark);
      const address = this.netns.address(octet);
      await this.rekey(address, token, mark);
      if (performance.now() - t0 > 500)
        this.d.log.info({ vm: id, phases: marks }, "microvm: slow restore");
      return this.info(meta, true);
    } catch (e) {
      await this.remove(id).catch(() => undefined);
      throw e;
    }
  }

  private async restore(
    id: string,
    octet: number,
    mark: (k: string) => void = () => undefined,
  ): Promise<void> {
    const c = this.c;
    // The jailer: chroot, an unprivileged user, its own cgroup and network namespace, detached so
    // the VM outlives an agent restart (as a container outlives one with live-restore).
    await this.d.run(c.jailer, [
      "--id",
      id,
      "--exec-file",
      c.firecracker,
      "--uid",
      String(c.vmUid),
      "--gid",
      String(c.vmGid),
      "--chroot-base-dir",
      join(c.dir, "jail"),
      "--netns",
      `/var/run/netns/${this.netns.name(octet)}`,
      "--cgroup-version",
      "2",
      "--parent-cgroup",
      c.cgroupParent,
      // The guest gets its vCPUs; the VMM's own work (and nested virtualisation's) needs room on top.
      "--cgroup",
      `cpu.max=${c.vcpus * 200_000} 100000`,
      "--cgroup",
      `memory.max=${(c.memMib + 256) * 1024 * 1024}`,
      "--cgroup",
      "memory.swap.max=0",
      "--cgroup",
      "pids.max=64",
      "--new-pid-ns",
      "--daemonize",
      "--",
      "--api-sock",
      "/run/firecracker.socket",
      "--level",
      "Warn",
    ]);
    const root = this.root(id);
    // The snapshot's files, linked (not copied) into the chroot: the memory file is mapped
    // copy-on-write, so clones share every page none of them has written.
    const t = join(c.dir, "template");
    mark("jailer");
    for (const f of ["vmstate", "mem", "rootfs.ext4"])
      await link(join(t, f), join(root, f));
    const sock = join(root, "run", "firecracker.socket");
    for (let i = 0; ; i++) {
      try {
        await unixCall(sock, "PUT", "/snapshot/load", {
          snapshot_path: "/vmstate",
          mem_backend: { backend_type: "File", backend_path: "/mem" },
          resume_vm: true,
        });
        mark("load");
        return;
      } catch (e) {
        // The socket appears a moment after the jailer returns.
        if (i > 500 || !/ENOENT|ECONNREFUSED/.test(String(e))) throw e;
        await sleep(2);
      }
    }
  }

  /** The clone starts with the template's token: replace it with this browser's own (T-16). */
  private async rekey(
    address: string,
    token: string,
    mark: (k: string) => void = () => undefined,
  ): Promise<void> {
    const template = await this.token();
    const base = `http://${address}:${RUNTIME_PORTS.control}`;
    const until = Date.now() + 10_000;
    for (;;) {
      try {
        const h = RuntimeHealth.parse(
          await (
            await this.fetchFn(`${base}${RUNTIME_PATHS.health}`, {
              headers: { authorization: `Bearer ${template}` },
              signal: AbortSignal.timeout(1000),
            })
          ).json(),
        );
        if (h.status === "ready") {
          mark("health");
          break;
        }
      } catch {
        /* resuming: its network answers in tens of milliseconds */
      }
      if (Date.now() > until)
        throw new Error("microvm: the restored browser did not answer");
      await sleep(3);
    }
    const res = await this.fetchFn(`${base}${RUNTIME_PATHS.rekey}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${template}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`microvm: rekey refused (${res.status})`);
    RekeyResponse.parse(await res.json());
    mark("rekey");
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    if (!id.startsWith("vm-")) return null;
    const m = await readFile(this.metaPath(id), "utf8")
      .then((t) => JSON.parse(t) as Meta)
      .catch(() => null);
    if (!m) return null;
    const pid = await this.pid(id);
    return this.info(m, pid !== null && this.procs.alive(pid));
  }

  /** Kill the VMM; nothing is torn down by a daemon, so a removal does not slow anything else. */
  async remove(id: string): Promise<void> {
    if (!id.startsWith("vm-")) return;
    this.removing.add(id);
    try {
      const m = await readFile(this.metaPath(id), "utf8")
        .then((t) => JSON.parse(t) as Meta)
        .catch(() => null);
      const pid = await this.pid(id);
      if (pid !== null) {
        this.procs.kill(pid);
        for (let i = 0; i < 500 && this.procs.alive(pid); i++) await sleep(2);
      }
      await rm(join(this.jail, id), { recursive: true, force: true });
      await rmdir(join("/sys/fs/cgroup", this.c.cgroupParent, id)).catch(
        () => undefined,
      );
      if (m) await this.netns.release(m.octet);
      await rm(this.metaPath(id), { force: true });
    } finally {
      this.removing.delete(id);
      this.dead.delete(id);
    }
  }

  /** A frozen VM would hold its memory for nothing: removal is cheap, so the agent removes at once. */
  async pause(_id: string): Promise<void> {
    throw new Error("microvm: removed at once, not frozen");
  }

  async list(): Promise<ContainerInfo[]> {
    const out: ContainerInfo[] = [];
    for (const m of await this.metas()) {
      const pid = await this.pid(m.id);
      out.push(this.info(m, pid !== null && this.procs.alive(pid)));
    }
    return out;
  }

  onEvent(cb: (e: DockerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async poll(): Promise<void> {
    for (const m of await this.metas()) {
      if (this.removing.has(m.id) || this.dead.has(m.id)) continue;
      const pid = await this.pid(m.id);
      if (pid !== null && this.procs.alive(pid)) continue;
      // Not yet started (the jailer writes the pid a moment after the meta file): not dead.
      if (Date.now() - m.createdAt < 5_000) continue;
      this.dead.add(m.id);
      for (const l of this.listeners)
        l({ id: m.id, action: "die", exitCode: 137 });
    }
  }
}

/**
 * The node's driver when it runs microVMs: VMs for browsers, Docker for what VMs do not do yet.
 * A container with a mount is one that records (W3); recording into a VM would mean reading a
 * guest-written disk on the host, so those stay containers for now (v1 plan section 8).
 */
export class RoutedDriver implements DockerDriver {
  constructor(
    private readonly vm: DockerDriver,
    private readonly docker: DockerDriver,
  ) {}

  private pick(id: string): DockerDriver {
    return id.startsWith("vm-") ? this.vm : this.docker;
  }

  run(spec: Docker.ContainerCreateOptions): Promise<ContainerInfo> {
    return (spec.HostConfig?.Mounts?.length ?? 0) > 0
      ? this.docker.run(spec)
      : this.vm.run(spec);
  }
  inspect(id: string): Promise<ContainerInfo | null> {
    return this.pick(id).inspect(id);
  }
  remove(id: string): Promise<void> {
    return this.pick(id).remove(id);
  }
  pause(id: string): Promise<void> {
    return this.pick(id).pause(id);
  }
  async list(): Promise<ContainerInfo[]> {
    const [a, b] = await Promise.all([this.vm.list(), this.docker.list()]);
    return [...a, ...b];
  }
  onEvent(cb: (e: DockerEvent) => void): () => void {
    const a = this.vm.onEvent(cb);
    const b = this.docker.onEvent(cb);
    return () => (a(), b());
  }
}
