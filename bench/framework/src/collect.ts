import { readFileSync } from "node:fs";
import { request } from "node:http";
import { uuidToId } from "@kestrel/contracts";
import { createPrisma } from "@kestrel/db";
import Docker from "dockerode";
import type {
  AgentView,
  DockerContainer,
  EgressView,
  GatewayView,
  Snapshot,
} from "./invariants.js";

/**
 * Fill an invariant snapshot from a real host (H5). Runs on the host itself (inside the platform
 * image, with the Docker socket, the secrets and the node's runtime directory mounted), because
 * what it compares is exactly what is invisible from outside: Docker, the database, each agent's
 * store, the egress gateway's policies, the gateways' routes and the firewall.
 */
export interface HostConfig {
  nodes: {
    id: string;
    agentPort: number;
    gatewayMetricsPort: number;
    secretFile: string;
    iface: string;
    bridgeIp: string;
    egressSocket: string;
  }[];
  apiInternal: string;
  databaseUrlFile: string;
  dockerSocket?: string;
}

export const DEFAULT_HOST: HostConfig = {
  nodes: [
    {
      id: "a",
      agentPort: 7001,
      gatewayMetricsPort: 7201,
      secretFile: "/secrets/node-a.secret",
      iface: "ksl-a",
      bridgeIp: "172.30.1.1",
      egressSocket: "/run/kestrel/a/egress.sock",
    },
  ],
  apiInternal: "http://127.0.0.1:8081",
  databaseUrlFile: "/secrets/database-url",
};

function unixGet(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = request(
      { socketPath, path, method: "GET", timeout: 3000 },
      (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(t));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", reject);
    r.end();
  });
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export function mapContainer(i: Docker.ContainerInspectInfo): DockerContainer {
  const h = i.HostConfig;
  return {
    id: i.Id,
    node: i.Config?.Labels?.["kestrel.node"] ?? null,
    role: i.Config?.Labels?.["kestrel.role"] ?? null,
    running: Boolean(i.State?.Running),
    address:
      Object.values(i.NetworkSettings?.Networks ?? {})[0]?.IPAddress || null,
    config: {
      privileged: Boolean(h?.Privileged),
      capAdd: h?.CapAdd ?? [],
      capDrop: h?.CapDrop ?? [],
      readonlyRootfs: Boolean(h?.ReadonlyRootfs),
      user: i.Config?.User ?? "",
      pidsLimit: h?.PidsLimit && h.PidsLimit > 0 ? h.PidsLimit : null,
      memory: h?.Memory && h.Memory > 0 ? h.Memory : null,
      memorySwap: h?.MemorySwap && h.MemorySwap !== 0 ? h.MemorySwap : null,
      nanoCpus: h?.NanoCpus && h.NanoCpus > 0 ? h.NanoCpus : null,
      tmpfs: (h?.Tmpfs as Record<string, string> | undefined) ?? {},
      ports: Object.keys(h?.PortBindings ?? {}).length,
      binds: (h?.Binds ?? []).length,
      networkMode: h?.NetworkMode ?? "",
      noNewPrivileges: (h?.SecurityOpt ?? []).some((o: string) =>
        o.startsWith("no-new-privileges"),
      ),
    },
  };
}

export async function collectSnapshot(
  cfg: HostConfig = DEFAULT_HOST,
  opts: { failpointsExpected?: boolean } = {},
): Promise<Snapshot> {
  const docker = new Docker({
    socketPath: cfg.dockerSocket ?? "/var/run/docker.sock",
  });
  const listed = await docker.listContainers({
    all: true,
    filters: { label: ["kestrel.node"] },
  });
  const containers = await Promise.all(
    listed.map(async (c) =>
      mapContainer(await docker.getContainer(c.Id).inspect()),
    ),
  );

  const db = createPrisma(readFileSync(cfg.databaseUrlFile, "utf8").trim(), {
    max: 1,
  });
  let api: Snapshot["api"];
  try {
    const rows = await db.$queryRaw<
      { id: string; status: string; node_id: string | null; age: number }[]
    >`
      SELECT id, status::text AS status, node_id, extract(epoch FROM (now() - coalesce(stopping_at, created_at)))::float8 AS age
      FROM sessions WHERE status IN ('requested','scheduling','starting','ready','active','stopping')`;
    api = rows.map((r) => ({
      id: uuidToId("ses", r.id),
      status: r.status,
      nodeId: r.node_id,
      ageSeconds: r.age,
    }));
  } finally {
    await db.$disconnect();
  }

  const agents: AgentView[] = [];
  const egress: EgressView[] = [];
  const gateways: GatewayView[] = [];
  const firewall: Snapshot["firewall"] = [];
  const failpoints: Snapshot["failpoints"] = [];
  // The firewall check is the node agent's own, loaded from its build rather than copied.
  type Fw = new (c: {
    nodeId: string;
    iface: string;
    bridgeIp: string;
    egressPort: number;
  }) => { verify(): Promise<{ ok: boolean; problems: string[] }> };
  const modulePath = "../../../apps/node/dist/firewall.js";
  const { Firewall } = (await import(/* @vite-ignore */ modulePath)) as {
    Firewall: Fw;
  };

  const apiHealth = (await getJson(`${cfg.apiInternal}/healthz`).catch(() => ({
    failpoints: {},
  }))) as { failpoints?: Record<string, string> };
  failpoints.push({ process: "api", active: apiHealth.failpoints ?? {} });

  for (const n of cfg.nodes) {
    const secret = readFileSync(n.secretFile, "utf8").trim();
    const st = (await getJson(`http://127.0.0.1:${n.agentPort}/v1/state`, {
      authorization: `Bearer ${secret}`,
    })) as {
      sessions: {
        sessionId: string;
        state: string;
        address: string | null;
        containerId: string | null;
      }[];
      pool: { containerId: string; address: string }[];
      pendingReports: number;
      slotsTotal: number;
      failpoints: Record<string, string>;
    };
    agents.push({
      node: n.id,
      slotsTotal: st.slotsTotal,
      sessions: st.sessions,
      pool: st.pool,
      pendingReports: st.pendingReports,
    });
    failpoints.push({ process: `node-${n.id}`, active: st.failpoints });

    const pol = (await unixGet(n.egressSocket, "/v1/policies")) as {
      policies: { ip: string; sessionId: string }[];
    };
    const health = (await unixGet(n.egressSocket, "/v1/health")) as {
      policiesRestored: boolean;
    };
    egress.push({
      node: n.id,
      policies: pol.policies.map((p) => ({ ip: p.ip, sessionId: p.sessionId })),
      policiesRestored: health.policiesRestored,
    });

    const gw = (await getJson(
      `http://127.0.0.1:${n.gatewayMetricsPort}/routes`,
    ).catch(() => null)) as {
      routes: string[];
      attachments: { sessionId: string; connections: number }[];
    } | null;
    gateways.push({
      node: n.id,
      routes: gw?.routes ?? null,
      attachments: gw?.attachments ?? [],
    });

    const fw = await new Firewall({
      nodeId: n.id,
      iface: n.iface,
      bridgeIp: n.bridgeIp,
      egressPort: 3128,
    }).verify();
    firewall.push({ node: n.id, ok: fw.ok, problems: fw.problems });
  }

  return {
    docker: containers,
    api,
    agents,
    egress,
    gateways,
    firewall,
    failpoints,
    failpointsExpected: Boolean(opts.failpointsExpected),
  };
}

/**
 * Collect and check, retrying while the system settles: the invariants hold at rest, and a
 * teardown that has just been requested is allowed a few seconds to finish.
 */
export async function settledInvariants(
  check: (s: Snapshot) => { rule: string; detail: string }[],
  cfg: HostConfig = DEFAULT_HOST,
  opts: { timeoutMs?: number; failpointsExpected?: boolean } = {},
): Promise<{ ok: boolean; violations: { rule: string; detail: string }[] }> {
  const until = Date.now() + (opts.timeoutMs ?? 30_000);
  let v: { rule: string; detail: string }[] = [];
  for (;;) {
    try {
      v = check(
        await collectSnapshot(
          cfg,
          opts.failpointsExpected ? { failpointsExpected: true } : {},
        ),
      );
    } catch (e) {
      v = [
        {
          rule: "collect-failed",
          detail: e instanceof Error ? e.message : String(e),
        },
      ];
    }
    if (v.length === 0 || Date.now() > until)
      return { ok: v.length === 0, violations: v };
    await new Promise((r) => setTimeout(r, 2000));
  }
}
