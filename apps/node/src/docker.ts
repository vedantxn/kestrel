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

export type Role = "pool" | "session";
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
    Labels: { "kestrel.node": cfg.nodeId, "kestrel.role": role },
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

  async inspect(id: string): Promise<ContainerInfo | null> {
    try {
      return this.toInfo(await this.docker.getContainer(id).inspect());
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
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
    const out: ContainerInfo[] = [];
    for (const r of rows) {
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
