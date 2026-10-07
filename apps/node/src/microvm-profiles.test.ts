import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createLogger } from "@kestrel/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfo, DockerDriver } from "./docker.js";
import {
  MicroVmDriver,
  RoutedDriver,
  WarmCloneError,
  type Cgroups,
  type Exec,
  type MicroVmConfig,
  type Procs,
} from "./microvm.js";

/*
 * P18-8 (docs/lld/p18-profiles.md 4.3): on a microVM node a session that restores a profile is a
 * clone of a second template, snapshotted before Chrome started. Its clone is rekeyed without a
 * fresh page (runtimed has no Chrome to make one in) and refused if its clock is off the host's.
 */

const log = createLogger("microvm-profiles-test", "silent");
const HOT_TOKEN = "h".repeat(40);
const WARM_TOKEN = "w".repeat(40);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function config(dir: string): MicroVmConfig {
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
  };
}

/** The host as the driver sees it: a jailer that makes a chroot with a Firecracker API that answers. */
function fakeHost(dir: string) {
  const calls: string[] = [];
  const servers: Server[] = [];
  const pids = new Map<number, string>();
  let nextPid = 7000;
  const run: Exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`);
    if (cmd.endsWith("jailer")) {
      const id = args[args.indexOf("--id") + 1]!;
      const root = join(dir, "jail", "firecracker", id, "root");
      mkdirSync(join(root, "run"), { recursive: true });
      const pid = nextPid++;
      pids.set(pid, id);
      writeFileSync(join(root, "firecracker.pid"), String(pid));
      const srv = createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(204).end());
      });
      await new Promise<void>((r) =>
        srv.listen(join(root, "run", "firecracker.socket"), r),
      );
      servers.push(srv);
    }
    return "";
  };
  const procs: Procs = {
    isVmm: async (pid, id) => pids.get(pid) === id,
    isHandler: async () => false,
    alive: (pid) => pids.has(pid),
    kill: (pid) => void pids.delete(pid),
    start: async () => 1,
  };
  const cgroups: Cgroups = {
    path: (parent, id) => `/sys/fs/cgroup/${parent}/${id}`,
    children: async () => [],
    empty: async () => true,
    remove: async () => "removed",
  };
  return { run, calls, servers, procs, cgroups };
}

/** The clone's runtimed: its health, and a rekey that answers with the guest's clock. */
function guest(opts: { status: string; skewMs?: number | null }) {
  const seen: { url: string; auth: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization") ?? "",
    });
    if (String(url).endsWith("/health"))
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          status: opts.status,
          chromeReady: opts.status === "ready",
          chromeVersion: null,
        }),
      );
    return new Response(
      JSON.stringify({
        ok: true,
        ...(opts.skewMs === null
          ? {}
          : { now: Date.now() + (opts.skewMs ?? 0) }),
      }),
    );
  }) as typeof fetch;
  return { f, seen };
}

async function rig(g: ReturnType<typeof guest>, warmTemplate = true) {
  const dir = mkdtempSync("/tmp/mvp-");
  for (const [name, token] of [
    ["template", HOT_TOKEN],
    ...(warmTemplate ? [["template-warm", WARM_TOKEN]] : []),
  ] as const) {
    mkdirSync(join(dir, name), { recursive: true });
    for (const f of ["vmstate", "mem", "rootfs.ext4"])
      writeFileSync(join(dir, name, f), `${name}:${f}`);
    writeFileSync(join(dir, name, "token"), `${token}\n`);
  }
  const host = fakeHost(dir);
  const vm = new MicroVmDriver(config(dir), {
    run: host.run,
    log,
    fetch: g.f,
    procs: host.procs,
    cgroups: host.cgroups,
  });
  await vm.start();
  cleanup.push(() => {
    vm.stop();
    for (const s of host.servers) s.close();
  });
  return { dir, host, vm };
}

const spec = (level?: "warm") => ({
  Env: [`KESTREL_CONTROL_TOKEN=${"c".repeat(48)}`],
  Labels: {
    "kestrel.node": "a",
    "kestrel.role": "session",
    ...(level ? { "kestrel.level": level } : {}),
  },
});

const linked = (dir: string, id: string) =>
  readFileSync(join(dir, "jail", "firecracker", id, "root", "mem"), "utf8");

describe("warm clones", () => {
  it("restore a warm spec from the warm template, rekeyed with its token, once runtimed says warm", async () => {
    const g = guest({ status: "warm" });
    const { dir, vm } = await rig(g);
    const info = await vm.run(spec("warm"));
    expect(linked(dir, info.id)).toBe("template-warm:mem");
    const rekey = g.seen.find((s) => s.url.endsWith("/rekey"))!;
    expect(rekey.auth).toBe(`Bearer ${WARM_TOKEN}`);
  });

  it("leave every other spec on the hot template", async () => {
    const g = guest({ status: "ready" });
    const { dir, vm } = await rig(g);
    const info = await vm.run(spec());
    expect(linked(dir, info.id)).toBe("template:mem");
    expect(g.seen.find((s) => s.url.endsWith("/rekey"))!.auth).toBe(
      `Bearer ${HOT_TOKEN}`,
    );
  });

  it("are refused, and removed, when the guest's clock is more than 2 s off the host's", async () => {
    for (const skewMs of [3_000, -3_000, null]) {
      const g = guest({ status: "warm", skewMs });
      const { vm } = await rig(g);
      await expect(vm.run(spec("warm")), String(skewMs)).rejects.toBeInstanceOf(
        WarmCloneError,
      );
      expect(await vm.list()).toEqual([]);
    }
    const ok = guest({ status: "warm", skewMs: 1_500 });
    const { vm } = await rig(ok);
    await expect(vm.run(spec("warm"))).resolves.toMatchObject({
      running: true,
    });
  });

  it("only gate a warm clone on its clock: a hot one is never refused for it", async () => {
    const g = guest({ status: "ready", skewMs: 60_000 });
    const { vm } = await rig(g);
    await expect(vm.run(spec())).resolves.toMatchObject({ running: true });
  });

  it("are refused before anything is made on a node without the warm template", async () => {
    const g = guest({ status: "warm" });
    const { host, vm } = await rig(g, false);
    await expect(vm.run(spec("warm"))).rejects.toBeInstanceOf(WarmCloneError);
    expect(host.calls.some((c) => c.includes("jailer"))).toBe(false);
  });
});

describe("MICROVM_PROFILES=docker", () => {
  it("makes a warm browser a Docker container, and leaves the rest as before", async () => {
    const used: string[] = [];
    const fake = (name: string): DockerDriver => ({
      run: async (s) => {
        used.push(`${name}:${s.Labels?.["kestrel.level"] ?? "hot"}`);
        return {
          id: name === "vm" ? "vm-1" : "c1",
          labels: {},
          running: true,
          address: "x",
          oomKilled: false,
          exitCode: null,
          createdAt: 0,
        } satisfies ContainerInfo;
      },
      inspect: async () => null,
      remove: async () => undefined,
      pause: async () => undefined,
      list: async () => [],
      onEvent: () => () => undefined,
    });
    const docker = new RoutedDriver(fake("vm"), fake("docker"), {
      profilesOnDocker: true,
    });
    await docker.run(spec("warm"));
    await docker.run(spec());
    const vms = new RoutedDriver(fake("vm"), fake("docker"));
    await vms.run(spec("warm"));
    expect(used).toEqual(["docker:warm", "vm:hot", "vm:warm"]);
  });
});
