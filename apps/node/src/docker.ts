import { RECORDING_DIR } from "@kestrel/contracts";
import Docker from "dockerode";
import { RUNTIME_PORTS } from "@kestrel/contracts";

export interface NodeConfigForDocker {
  nodeId: string;
  image: string;
  network: string;
  bridgeIp: string;
  egressPort: number;
  /** One parent control group for all session containers, with a ceiling that leaves room for the platform (R14). */
  cgroupParent: string;
  /** The seccomp profile as JSON text; it allows user namespaces if experiment V1 says the sandbox is on (R12). */
  seccompProfile: string | null;
}

/** A probe is the harness's (G-23): made only when the agent's harness surface is on. */
export type Role = "pool" | "session" | "probe";
export const MiB = 1024 * 1024;

/**
 * The container as the HLD's hardened profile describes it (R10-R14, R16): one unprivileged
 * user, every capability dropped, no new privileges, a read-only root, a process limit, a fixed
 * share of CPU and memory, memory-backed no-exec writable spaces, a real init, never privileged,
 * logs to the journal without ever blocking the browser. A pure function so the profile can be
 * checked in tests and, on the host, against what Docker actually created (threat model G-05).
 */
export function buildContainerSpec(
  cfg: NodeConfigForDocker,
  role: Role,
  controlToken: string,
  /** W3: the container's recording volume, if the node could make one. */
  recordingVolume?: string,
): Docker.ContainerCreateOptions {
  const tmpfs = (size: number) =>
    `rw,noexec,nosuid,nodev,size=${size}m,uid=10001,gid=10001,mode=0700`;
  return {
    Image: cfg.image,
    User: "10001:10001",
    Env: [
      `KESTREL_CONTROL_TOKEN=${controlToken}`,
      `KESTREL_PROXY=http://${cfg.bridgeIp}:${cfg.egressPort}`,
      `KESTREL_NODE=${cfg.nodeId}`,
    ],
    Labels: {
      "kestrel.node": cfg.nodeId,
      "kestrel.role": role,
      ...(recordingVolume ? { "kestrel.volume": recordingVolume } : {}),
    },
    // No exposed or published ports: the agent and gateway reach the container by its address on the internal network.
    HostConfig: {
      NetworkMode: cfg.network,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: [
        "no-new-privileges",
        ...(cfg.seccompProfile ? [`seccomp=${cfg.seccompProfile}`] : []),
      ],
      ReadonlyRootfs: true,
      PidsLimit: 1024,
      Memory: 2048 * MiB,
      MemorySwap: 2048 * MiB, // equal to Memory: no swap
      NanoCpus: 1_000_000_000,
      ShmSize: 1024 * MiB,
      Tmpfs: {
        "/profile": tmpfs(512),
        "/tmp": tmpfs(64),
        "/home/kestrel": tmpfs(64),
      },
      ...(recordingVolume
        ? {
            Mounts: [
              {
                Type: "volume" as const,
                Source: recordingVolume,
                Target: RECORDING_DIR,
                ReadOnly: false,
              },
            ],
          }
        : {}),
      Init: true,
      CgroupParent: cfg.cgroupParent,
      RestartPolicy: { Name: "no" }, // a browser is used once: nothing is restarted in place (R6)
      Dns: [], // no resolver: only the egress gateway resolves names (N1)
      LogConfig: {
        Type: "journald",
        Config: {
          tag: `kestrel-${role}`,
          mode: "non-blocking",
          "max-buffer-size": "4m",
        },
      },
      AutoRemove: false,
    },
    StopTimeout: 2,
  };
}

/** What the agent needs to know about a container. */
export interface ContainerInfo {
  id: string;
  labels: Record<string, string>;
  running: boolean;
  address: string | null;
  oomKilled: boolean;
  exitCode: number | null;
  /** Epoch ms. Reconciliation leaves very new containers alone: the agent may not have recorded them yet. */
  createdAt: number;
}

export type DockerEvent = {
  id: string;
  action: "die" | "oom" | "destroy" | "start";
  exitCode: number | null;
};

export interface DockerDriver {
  /** Create and start; returns once the container exists and has an address. */
  run(spec: Docker.ContainerCreateOptions): Promise<ContainerInfo>;
  inspect(id: string): Promise<ContainerInfo | null>;
  /** Force-remove. Idempotent: a container that is already gone is not an error. */
  remove(id: string): Promise<void>;
  /** Freeze every process in the container (cgroup freezer). Cheap: no network teardown. */
  pause(id: string): Promise<void>;
  /** Containers carrying this node's label, and only those (G3). */
  list(): Promise<ContainerInfo[]>;
  onEvent(cb: (e: DockerEvent) => void): () => void;
}

export class DockerodeDriver implements DockerDriver {
  private docker: Docker;

  constructor(
    private readonly nodeId: string,
    private readonly network: string,
    opts: Docker.DockerOptions = { socketPath: "/var/run/docker.sock" },
  ) {
    this.docker = new Docker(opts);
  }

  private toInfo(i: Docker.ContainerInspectInfo): ContainerInfo {
    return {
      id: i.Id,
      labels: i.Config?.Labels ?? {},
      running: Boolean(i.State?.Running),
      address: i.NetworkSettings?.Networks?.[this.network]?.IPAddress || null,
      oomKilled: Boolean(i.State?.OOMKilled),
      exitCode: typeof i.State?.ExitCode === "number" ? i.State.ExitCode : null,
      createdAt: Date.parse(i.Created) || 0,
    };
  }

  async run(spec: Docker.ContainerCreateOptions): Promise<ContainerInfo> {
    const c = await this.docker.createContainer(spec);
    try {
      await c.start();
      return this.toInfo(await c.inspect());
    } catch (e) {
      await c.remove({ force: true }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * N1. One bridge per node: internal (no route out), no IPv6, containers unable to talk to each
   * other, with the interface name set explicitly so the firewall rules can match it. Created if
   * absent; an existing one is left alone.
   */
  async ensureNetwork(o: {
    name: string;
    iface: string;
    subnet: string;
    gateway: string;
    /** The part of the subnet Docker may allocate from (the rest is the microVMs'). */
    ipRange?: string;
  }): Promise<void> {
    const existing = await this.docker.listNetworks({
      filters: { name: [o.name] },
    });
    if (existing.some((n) => n.Name === o.name)) return;
    await this.docker.createNetwork({
      Name: o.name,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      IPAM: {
        Config: [
          {
            Subnet: o.subnet,
            Gateway: o.gateway,
            ...(o.ipRange ? { IPRange: o.ipRange } : {}),
          },
        ],
      },
      Options: {
        "com.docker.network.bridge.name": o.iface,
        "com.docker.network.bridge.enable_icc": "false",
      },
      Labels: { "kestrel.node": this.nodeId },
    });
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    try {
      return this.toInfo(await this.docker.getContainer(id).inspect());
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }

  async pause(id: string): Promise<void> {
    await this.docker.getContainer(id).pause();
  }

  async remove(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true, v: true });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code !== 404 && code !== 409) throw e; // 409: removal already in progress
    }
  }

  async list(): Promise<ContainerInfo[]> {
    const rows = await this.docker.listContainers({
      all: true,
      filters: { label: [`kestrel.node=${this.nodeId}`] },
    });
    // The list already carries what a running container needs (state, labels, address, age).
    // Only a stopped one is inspected, for its exit code and whether it was OOM-killed. Inspecting
    // every container every 5 s was ~16 Docker calls a second on a busy host, and the daemon
    // serializes container work: it slowed the container starts that refill the pool.
    const out: ContainerInfo[] = [];
    for (const r of rows) {
      if ((r.Labels ?? {})["kestrel.node"] !== this.nodeId) continue;
      // A paused container is a frozen, retired one waiting for the reaper: Docker reports it as
      // running, and the listing has all it needs, so it is not inspected either.
      if (r.State === "running" || r.State === "paused") {
        out.push({
          id: r.Id,
          labels: r.Labels ?? {},
          running: true,
          address:
            r.NetworkSettings?.Networks?.[this.network]?.IPAddress || null,
          oomKilled: false,
          exitCode: null,
          createdAt: r.Created * 1000,
        });
        continue;
      }
      const info = await this.inspect(r.Id);
      if (info && info.labels["kestrel.node"] === this.nodeId) out.push(info);
    }
    return out;
  }

  onEvent(cb: (e: DockerEvent) => void): () => void {
    let stop = false;
    let stream: NodeJS.ReadableStream | undefined;
    const loop = async (): Promise<void> => {
      while (!stop) {
        try {
          stream = await this.docker.getEvents({
            filters: {
              type: ["container"],
              label: [`kestrel.node=${this.nodeId}`],
              event: ["die", "oom", "destroy", "start"],
            },
          });
          await new Promise<void>((resolve) => {
            let buf = "";
            stream!.on("data", (d: Buffer) => {
              buf += d.toString();
              let i;
              while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                try {
                  const ev = JSON.parse(line) as {
                    id?: string;
                    Action?: string;
                    Actor?: { Attributes?: Record<string, string> };
                  };
                  const code = ev.Actor?.Attributes?.exitCode;
                  if (ev.id && ev.Action)
                    cb({
                      id: ev.id,
                      action: ev.Action as DockerEvent["action"],
                      exitCode: code === undefined ? null : Number(code),
                    });
                } catch {
                  /* ignore a malformed line */
                }
              }
            });
            stream!.on("end", resolve);
            stream!.on("error", resolve);
          });
        } catch {
          /* the daemon restarted: reconnect */
        }
        if (!stop) await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void loop();
    return () => {
      stop = true;
      (stream as unknown as { destroy?: () => void } | undefined)?.destroy?.();
    };
  }
}

export const CDP_PORT = RUNTIME_PORTS.cdpForward;

/**
 * W3. A named volume per container for its recording, so the video outlives the container.
 * Docker enforces the size with project quotas on the xfs data root; a node without them gets
 * no volume and its sessions are not recorded. The volumes directory is mounted noexec on the
 * host (`infra/terraform/main/userdata.sh.tpl`), which every mount of a volume inherits.
 */
export interface Volumes {
  /** Create a size-limited volume; throws if the host cannot limit its size. */
  create(name: string, sizeBytes: number): Promise<void>;
  /** Idempotent. */
  remove(name: string): Promise<void>;
  /** This node's recording volumes, with when each was created (epoch ms). */
  list(): Promise<{ name: string; createdAt: number }[]>;
  /** The host directory holding the volume's files, as the agent sees it. */
  path(name: string): Promise<string | null>;
}

export class DockerVolumes implements Volumes {
  private docker: Docker;
  constructor(
    private readonly nodeId: string,
    opts: Docker.DockerOptions = { socketPath: "/var/run/docker.sock" },
  ) {
    this.docker = new Docker(opts);
  }

  async create(name: string, sizeBytes: number): Promise<void> {
    await this.docker.createVolume({
      Name: name,
      Driver: "local",
      DriverOpts: { size: String(sizeBytes) },
      Labels: { "kestrel.node": this.nodeId, "kestrel.role": "recording" },
    });
  }

  async remove(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove({ force: true });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }

  async list(): Promise<{ name: string; createdAt: number }[]> {
    const r = await this.docker.listVolumes({
      filters: {
        label: [`kestrel.node=${this.nodeId}`, "kestrel.role=recording"],
      },
    });
    return (r.Volumes ?? []).map((v) => ({
      name: v.Name,
      createdAt: Date.parse((v as { CreatedAt?: string }).CreatedAt ?? "") || 0,
    }));
  }

  async path(name: string): Promise<string | null> {
    try {
      const v = await this.docker.getVolume(name).inspect();
      return v.Mountpoint || null;
    } catch {
      return null;
    }
  }
}
