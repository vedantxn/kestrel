import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  MicroVmDriver,
  NetnsPool,
  RoutedDriver,
  type Cgroups,
  type Exec,
  type MicroVmConfig,
  type Procs,
} from "./microvm.js";
import type { DockerDriver } from "./docker.js";

const log = createLogger("microvm-test", "silent");
const TEMPLATE_TOKEN = "t".repeat(40);

function config(dir: string, over: Partial<MicroVmConfig> = {}): MicroVmConfig {
  return {
    nodeId: "a",
    firecracker: "/opt/firecracker/firecracker",
    jailer: "/opt/firecracker/jailer",
    dir,
    cgroupParent: "kestrel-vm",
    bridge: "ksl-a",
    bridgeIp: "172.30.1.1",
    egressPort: 3128,
    subnetPrefix: "172.30.1",
    octets: [128, 131],
    vmUid: 10002,
    vmGid: 10002,
    netnsReady: 0,
    vcpus: 1,
    memMib: 2048,
    ...over,
  };
}

/** Records every command; the jailer fake makes the chroot and a Firecracker API that answers. */
function fakeHost(dir: string) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const servers: Server[] = [];
  const pids = new Map<number, string>(); // pid -> vm id
  const killed: number[] = [];
  /** VM cgroups by name: whether a process is in one, and how many removals answer EBUSY first. */
  const cg = new Map<string, { populated: boolean; busy: number }>();
  let nextPid = 5000;
  const run: Exec = async (cmd, args, input) => {
    calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
    if (cmd.endsWith("jailer")) {
      const id = args[args.indexOf("--id") + 1]!;
      const root = join(dir, "jail", "firecracker", id, "root");
      mkdirSync(join(root, "run"), { recursive: true });
      const pid = nextPid++;
      pids.set(pid, id);
      cg.set(id, { populated: true, busy: 0 });
      writeFileSync(join(root, "firecracker.pid"), String(pid));
      const srv = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          calls.push({
            cmd: "firecracker-api",
            args: [req.method!, req.url!],
            input: body,
          });
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((r) =>
        srv.listen(join(root, "run", "firecracker.socket"), r),
      );
      servers.push(srv);
    }
    if (cmd === "ip" && args[0] === "netns" && args[1] === "list") return "";
    return "";
  };
  const procs: Procs = {
    isVmm: async (pid, id) => pids.get(pid) === id,
    isHandler: async (pid, id) =>
      pids.get(pid)?.endsWith(`/${id}/root/uffd.sock`) ?? false,
    alive: (pid) => pids.has(pid),
    kill: (pid) => {
      killed.push(pid);
      const id = pids.get(pid);
      pids.delete(pid);
      const c = id ? cg.get(id) : undefined;
      if (c) c.populated = false;
    },
    start: async (cmd, args, uid, _gid, cgroup) => {
      calls.push({ cmd, args: [...args, `uid=${uid}`, `cgroup=${cgroup}`] });
      writeFileSync(args[0]!, ""); // the handler's socket
      const pid = nextPid++;
      pids.set(pid, `handler:${args[0]}`);
      return pid;
    },
  };
  const name = (path: string) => path.split("/").pop()!;
  const cgroups: Cgroups = {
    path: (parent, id) => `/sys/fs/cgroup/${parent}/${id}`,
    children: async () => [...cg.keys()],
    empty: async (path) => cg.get(name(path))?.populated === false,
    remove: async (path) => {
      const c = cg.get(name(path));
      if (!c) return "removed";
      if (c.populated) return "busy";
      if (c.busy > 0) {
        c.busy--;
        return "busy";
      }
      cg.delete(name(path));
      return "removed";
    },
  };
  return { run, calls, servers, procs, pids, killed, cg, cgroups };
}

/** The restored browser's control API: ready, then a rekey with the template's token. */
function fakeRuntime() {
  const seen: { url: string; auth: string; body?: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push({
      url: String(url),
      auth,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (String(url).endsWith("/health"))
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          status: "ready",
          chromeReady: true,
          chromeVersion: "x",
        }),
      );
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  return { f, seen };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

async function rig(over: Partial<MicroVmConfig> = {}) {
  // Short: a unix socket path is limited to about 104 bytes (macOS).
  const dir = mkdtempSync("/tmp/mv-");
  mkdirSync(join(dir, "template"), { recursive: true });
  for (const f of ["vmstate", "mem", "rootfs.ext4"])
    writeFileSync(join(dir, "template", f), f);
  writeFileSync(join(dir, "template", "token"), `${TEMPLATE_TOKEN}\n`);
  const host = fakeHost(dir);
  const rt = fakeRuntime();
  const vm = new MicroVmDriver(config(dir, over), {
    run: host.run,
    log,
    fetch: rt.f,
    procs: host.procs,
    cgroups: host.cgroups,
  });
  await vm.start();
  cleanup.push(() => {
    vm.stop();
    for (const s of host.servers) s.close();
  });
  return { dir, host, rt, vm };
}

const spec = (token = "c".repeat(48)) => ({
  Env: [
    `KESTREL_CONTROL_TOKEN=${token}`,
    "KESTREL_PROXY=http://172.30.1.1:3128",
  ],
  Labels: { "kestrel.node": "a", "kestrel.role": "pool" },
});

describe("network namespaces for microVMs", () => {
  it("gives each VM its own address on the bridge, and only lets the control, CDP and egress flows through", async () => {
    const host = fakeHost(mkdtempSync(join(tmpdir(), "ns-")));
    const pool = new NetnsPool(config("/x"), host.run, log);
    const o = await pool.take();
    expect(o).toBe(128);
    expect(pool.address(o)).toBe("172.30.1.128");
    const script = host.calls.find((c) => c.cmd === "sh")!.input!;
    expect(script).toContain("ip netns add kvm-a-128");
    expect(script).toContain("ip link set kva128 master ksl-a");
    // The same address always has the same MAC, so the host's ARP cache is never stale.
    expect(script).toContain(
      "peer name eth0 address 02:4b:00:1e:01:80 netns kvm-a-128",
    );
    expect(script).toContain(
      "ip -n kvm-a-128 addr add 172.30.1.128/24 dev eth0",
    );
    // Out: only to this node's egress gateway, as the namespace's own address.
    expect(script).toContain(
      "-A PREROUTING -i tap0 -d 172.16.0.1 -p tcp --dport 3128 -j DNAT --to-destination 172.30.1.1:3128",
    );
    expect(script).toContain("-A POSTROUTING -o eth0 -j MASQUERADE");
    expect(script).toContain(":FORWARD DROP [0:0]");
    // The guest's gateway MAC is the template's, which the guest has cached.
    expect(script).toContain("link set tap0 address 02:4b:ff:00:00:01");
    expect(script).toContain(":INPUT DROP [0:0]");
    // A second VM never shares the first's address.
    expect(await pool.take()).toBe(129);
  });

  it("deletes a namespace after use rather than reusing it, and frees its address", async () => {
    const host = fakeHost(mkdtempSync(join(tmpdir(), "ns-")));
    const pool = new NetnsPool(config("/x"), host.run, log);
    const o = await pool.take();
    await pool.release(o);
    expect(
      host.calls.some((c) => c.args.join(" ") === "netns del kvm-a-128"),
    ).toBe(true);
    expect(await pool.take()).toBe(128);
  });

  it("runs out of addresses loudly rather than sharing one", async () => {
    const host = fakeHost(mkdtempSync(join(tmpdir(), "ns-")));
    const pool = new NetnsPool(
      config("/x", { octets: [128, 129] }),
      host.run,
      log,
    );
    await pool.take();
    await pool.take();
    await expect(pool.take()).rejects.toThrow(/no address left/);
  });
});

describe("the microVM driver", () => {
  it("restores from the snapshot in a jail, then replaces the template's token with the container's own", async () => {
    const { host, rt, vm } = await rig();
    const info = await vm.run(spec());
    expect(info).toMatchObject({ running: true, address: "172.30.1.128" });
    expect(info.id).toMatch(/^vm-[0-9a-f]{24}$/);
    const jailer = host.calls.find((c) => c.cmd.endsWith("jailer"))!.args;
    expect(jailer).toEqual(
      expect.arrayContaining([
        "--uid",
        "10002",
        "--netns",
        "/var/run/netns/kvm-a-128",
        "--cgroup-version",
        "2",
        "--new-pid-ns",
        "--daemonize",
      ]),
    );
    expect(jailer).toContain("cpu.max=200000 100000");
    expect(host.calls.map((c) => c.args.join(" "))).toContain(
      "PUT /snapshot/load",
    );
    const rekey = rt.seen.find((s) => s.url.endsWith("/rekey"))!;
    expect(rekey.auth).toBe(`Bearer ${TEMPLATE_TOKEN}`);
    const sent = JSON.parse(rekey.body!) as { token: string; now: number };
    // The host's clock goes with the new token: the clone resumed with the template's (9.1).
    expect(sent).toEqual({ token: "c".repeat(48), now: expect.any(Number) });
    expect(Math.abs(sent.now - Date.now())).toBeLessThan(5_000);
    expect((await vm.list()).map((c) => c.id)).toEqual([info.id]);
  });

  it("with a page-fault handler, restores into 2 MiB pages filled from the snapshot, and removes the handler with the VM", async () => {
    const { host, vm } = await rig({
      uffdHandler: "/opt/firecracker/uffd_on_demand_handler",
    });
    const info = await vm.run(spec());
    const handler = host.calls.find((c) =>
      c.cmd.endsWith("uffd_on_demand_handler"),
    )!;
    // As the VM's user, in the VM's cgroup, so it outlives an agent restart and is charged to the VM.
    expect(handler.args).toContain("uid=10002");
    expect(handler.args.at(-1)).toBe(
      `cgroup=/sys/fs/cgroup/kestrel-vm/${info.id}`,
    );
    const load = host.calls.find(
      (c) => c.args.join(" ") === "PUT /snapshot/load",
    )!;
    expect(JSON.parse(load.input!)).toMatchObject({
      mem_backend: { backend_type: "Uffd", backend_path: "/uffd.sock" },
      huge_pages: "2M",
    });
    await vm.remove(info.id);
    expect(host.killed).toHaveLength(2); // the VMM and its handler
  });

  it("removes a VM completely: process, jail, namespace and record", async () => {
    const { dir, host, vm } = await rig();
    const info = await vm.run(spec());
    await vm.remove(info.id);
    expect(host.killed).toHaveLength(1);
    expect(existsSync(join(dir, "jail", "firecracker", info.id))).toBe(false);
    expect(
      host.calls.some((c) => c.args.join(" ") === "netns del kvm-a-128"),
    ).toBe(true);
    expect(await vm.inspect(info.id)).toBeNull();
    expect(await vm.list()).toEqual([]);
    await vm.remove(info.id); // idempotent
  });

  it("removes a VM's cgroup once its last process has left (EBUSY until then)", async () => {
    const { host, vm } = await rig();
    const info = await vm.run(spec());
    host.cg.get(info.id)!.busy = 3; // the VMM is still leaving after the kill
    await vm.remove(info.id);
    expect(host.cg.has(info.id)).toBe(false);
  });

  it("sweeps a VM cgroup that no VM owns, and nothing else (G-25)", async () => {
    const { host, vm } = await rig();
    const live = await vm.run(spec());
    // Left by an agent that died between the kill and the rmdir: empty, and no record names it.
    host.cg.set("vm-0123456789abcdef01234567", { populated: false, busy: 0 });
    // A process is still in it: never touched, whatever the records say.
    host.cg.set("vm-89abcdef0123456789abcdef", { populated: true, busy: 0 });
    // Not a VM's name.
    host.cg.set("other", { populated: false, busy: 0 });
    expect((await vm.list()).map((c) => c.id)).toEqual([live.id]);
    expect([...host.cg.keys()].sort()).toEqual(
      [live.id, "other", "vm-89abcdef0123456789abcdef"].sort(),
    );
  });

  it("is never frozen: the agent removes a stopped VM at once", async () => {
    const { vm } = await rig();
    const info = await vm.run(spec());
    await expect(vm.pause(info.id)).rejects.toThrow(/removed at once/);
  });

  it("reports a VM whose VMM is gone as a dead container", async () => {
    const { host, vm } = await rig();
    const info = await vm.run(spec());
    const pid = [...host.pids.keys()][0]!;
    host.pids.delete(pid); // the VMM exited by itself
    expect(await vm.inspect(info.id)).toMatchObject({ running: false });
  });

  it("treats a VM whose page-fault handler is gone as dead, and ends it (G-25)", async () => {
    const { dir, host, vm } = await rig({
      uffdHandler: "/opt/firecracker/uffd_on_demand_handler",
    });
    const info = await vm.run(spec());
    const died: string[] = [];
    vm.onEvent((e) => void died.push(`${e.id}:${e.action}`));
    const handler = [...host.pids].find(([, v]) => v.startsWith("handler:"));
    const vmm = [...host.pids].find(([, v]) => v === info.id)![0];
    host.pids.delete(handler![0]); // the handler was killed
    expect(await vm.inspect(info.id)).toMatchObject({ running: false });
    expect((await vm.list())[0]).toMatchObject({ running: false });
    // Old enough not to be mid-restore: the watch kills the VMM and reports the VM dead.
    const meta = join(dir, "meta", `${info.id}.json`);
    const m = JSON.parse(readFileSync(meta, "utf8")) as { createdAt: number };
    writeFileSync(
      meta,
      JSON.stringify({ ...m, createdAt: m.createdAt - 10_000 }),
    );
    for (let i = 0; i < 40 && died.length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(died).toEqual([`${info.id}:die`]);
    expect(host.killed).toContain(vmm);
  });

  it("makes a probe VM like a clone, rekeyed as a probe (G-23)", async () => {
    const { rt, vm } = await rig();
    const info = await vm.runProbe({
      ...spec(),
      Labels: { "kestrel.node": "a", "kestrel.role": "probe" },
    });
    expect(info).toMatchObject({ running: true, address: "172.30.1.128" });
    const rekey = rt.seen.find((s) => s.url.endsWith("/rekey"))!;
    expect(JSON.parse(rekey.body!)).toEqual({
      token: "c".repeat(48),
      probe: true,
      now: expect.any(Number),
    });
    expect(vm.describe()).toMatchObject({
      uid: 10002,
      cgroupParent: "kestrel-vm",
      octets: [128, 131],
      netns: { inUse: [128], ready: [], making: [] },
    });
  });

  it("does not trust a pid file that names some other process", async () => {
    const { dir, vm } = await rig();
    const info = await vm.run(spec());
    writeFileSync(
      join(dir, "jail", "firecracker", info.id, "root", "firecracker.pid"),
      "1234",
    );
    expect(await vm.inspect(info.id)).toMatchObject({ running: false });
  });
});

describe("a VM and the host's files (microVM recording)", () => {
  it("refuses a spec with a mount instead of restoring a VM that would silently not record", async () => {
    const { vm, host } = await rig();
    await expect(
      vm.run({
        ...spec(),
        HostConfig: {
          Mounts: [{ Type: "volume", Source: "v", Target: "/artifacts" }],
        },
      }),
    ).rejects.toThrow(/cannot mount/);
    expect(host.calls.some((c) => c.cmd.endsWith("jailer"))).toBe(false);
  });
});

describe("the routed driver", () => {
  it("makes a recording browser a container and everything else a VM, and routes by id", async () => {
    const used: string[] = [];
    const fake = (name: string): DockerDriver => ({
      run: async () => {
        used.push(`${name}:run`);
        return {
          id: name === "vm" ? "vm-1" : "c1",
          labels: {},
          running: true,
          address: "x",
          oomKilled: false,
          exitCode: null,
          createdAt: 0,
        };
      },
      inspect: async (id) => (used.push(`${name}:inspect:${id}`), null),
      remove: async (id) => void used.push(`${name}:remove:${id}`),
      pause: async () => undefined,
      list: async () => [],
      onEvent: () => () => undefined,
    });
    const r = new RoutedDriver(fake("vm"), fake("docker"));
    await r.run({});
    await r.run({
      HostConfig: {
        Mounts: [{ Type: "volume", Source: "v", Target: "/artifacts" }],
      },
    });
    await r.inspect("vm-1");
    await r.remove("c1");
    expect(used).toEqual([
      "vm:run",
      "docker:run",
      "vm:inspect:vm-1",
      "docker:remove:c1",
    ]);
  });
});
