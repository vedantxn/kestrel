import { readFileSync } from "node:fs";
import { request } from "node:http";
import {
  AGENT_STATE_PATH,
  AgentState,
  CREATION_LABEL,
  uuidToId,
} from "@kestrel/contracts";
import { createPrisma } from "@kestrel/db";
import Docker from "dockerode";
import {
  collectVmHosts,
  readHugePages,
  realHost,
  type HostReader,
} from "./collect-vm.js";
import {
  profileView,
  readProfileStoreDir,
  type ProfileRows,
} from "./collect-profiles.js";
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
    /** The agent's probe controls (KESTREL_HARNESS=on); default harness.sock beside the egress socket. */
    harnessSocket?: string;
  }[];
  apiInternal: string;
  databaseUrlFile: string;
  dockerSocket?: string;
  /** P18: the profile store's directory, mounted read-only; absent here means it is not judged. */
  profileStoreDir?: string;
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
  profileStoreDir: "/var/lib/kestrel/profiles",
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
    creation: i.Config?.Labels?.[CREATION_LABEL] ?? null,
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

export const harnessSocketOf = (n: HostConfig["nodes"][number]): string =>
  n.harnessSocket ?? n.egressSocket.replace(/[^/]+$/, "harness.sock");

/** A node agent's account of itself (`GET /v1/state`), checked against its contract. */
export async function agentState(
  n: HostConfig["nodes"][number],
): Promise<AgentState> {
  const secret = readFileSync(n.secretFile, "utf8").trim();
  return AgentState.parse(
    await getJson(`http://127.0.0.1:${n.agentPort}${AGENT_STATE_PATH}`, {
      authorization: `Bearer ${secret}`,
    }),
  );
}

export interface CollectOptions {
  failpointsExpected?: boolean;
  /** The agents' probe controls are on because this run turned them on. */
  harnessExpected?: boolean;
  /** Where microVM nodes are read from (tests replace it). */
  host?: HostReader;
}

export async function collectSnapshot(
  cfg: HostConfig = DEFAULT_HOST,
  opts: CollectOptions = {},
): Promise<Snapshot> {
  const dockerClient = new Docker({
    socketPath: cfg.dockerSocket ?? "/var/run/docker.sock",
  });
  const listed = await dockerClient.listContainers({
    all: true,
    filters: { label: ["kestrel.node"] },
  });
  const containers = await Promise.all(
    listed.map(async (c) =>
      mapContainer(await dockerClient.getContainer(c.Id).inspect()),
    ),
  );

  const db = createPrisma(readFileSync(cfg.databaseUrlFile, "utf8").trim(), {
    max: 1,
  });
  let api: Snapshot["api"];
  let profileRows: ProfileRows;
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
    // P18: locks and pending versions with their writer's state; the version rows the store's
    // blobs belong to (a deleted profile's rows count as none, as the API's collection counts them).
    profileRows = {
      locks: (
        await db.$queryRaw<
          {
            profile_id: string;
            session_id: string;
            status: string | null;
            age: number | null;
          }[]
        >`
        SELECT p.id::text AS profile_id, p.writer_session_id::text AS session_id, s.status::text AS status,
          extract(epoch FROM (now() - coalesce(s.ended_at, s.stopping_at, s.created_at)))::float8 AS age
        FROM profiles p LEFT JOIN sessions s ON s.id = p.writer_session_id
        WHERE p.writer_session_id IS NOT NULL`
      ).map((r) => ({
        profileUuid: r.profile_id,
        sessionUuid: r.session_id,
        status: r.status,
        age: r.age,
      })),
      pending: (
        await db.$queryRaw<
          {
            profile_id: string;
            version: number;
            session_id: string;
            status: string | null;
            age: number | null;
          }[]
        >`
        SELECT v.profile_id::text AS profile_id, v.version, v.session_id::text AS session_id, s.status::text AS status,
          extract(epoch FROM (now() - coalesce(s.ended_at, s.stopping_at, s.created_at)))::float8 AS age
        FROM profile_versions v LEFT JOIN sessions s ON s.id = v.session_id
        WHERE v.state = 'pending'`
      ).map((r) => ({
        profileUuid: r.profile_id,
        version: r.version,
        sessionUuid: r.session_id,
        status: r.status,
        age: r.age,
      })),
      versions: (
        await db.$queryRaw<
          { project_id: string; profile_id: string; version: number }[]
        >`
        SELECT p.project_id::text AS project_id, v.profile_id::text AS profile_id, v.version
        FROM profile_versions v JOIN profiles p ON p.id = v.profile_id
        WHERE p.deleted_at IS NULL`
      ).map((r) => ({
        projectUuid: r.project_id,
        profileUuid: r.profile_id,
        version: r.version,
      })),
    };
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

  const microvmNodes: Parameters<typeof collectVmHosts>[1] = [];
  for (const n of cfg.nodes) {
    const st = await agentState(n);
    agents.push({
      node: n.id,
      slotsTotal: st.slotsTotal,
      poolHeadroom: st.poolHeadroom,
      sessions: st.sessions,
      pool: st.pool,
      warm: st.warm,
      retiring: st.retiring,
      creating: st.creating,
      pendingReports: st.pendingReports,
      runtime: st.runtime,
      harness: st.harness,
    });
    if (st.runtime === "microvm" && st.microvm)
      microvmNodes.push({ node: n.id, layout: st.microvm });
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

  // Docker and the host were read before the agents: something made and removed in between is
  // in the listing and in no agent's account. Look again before calling it leaked.
  const host = opts.host ?? realHost;
  const owned = new Set(
    agents.flatMap((a) => [
      ...a.sessions.map((b) => b.containerId),
      ...a.pool.map((p) => p.containerId),
      ...(a.retiring ?? []),
      ...(a.harness?.probeVms ?? []).map((v) => v.id),
    ]),
  );
  const creating = new Set(agents.flatMap((a) => a.creating ?? []));
  const unowned = (id: string, creation: string | null | undefined) =>
    !owned.has(id) && !(creation && creating.has(creation));
  const docker: DockerContainer[] = [];
  for (const c of containers) {
    if (
      unowned(c.id, c.creation) &&
      !(await dockerClient
        .getContainer(c.id)
        .inspect()
        .then(
          () => true,
          () => false,
        ))
    )
      continue;
    docker.push(c);
  }
  let vms = await collectVmHosts(host, microvmNodes);
  if (vms.some((h) => h.vms.some((v) => unowned(v.id, v.meta?.creation)))) {
    const again = new Set(
      (await collectVmHosts(host, microvmNodes)).flatMap((h) =>
        h.vms.map((v) => v.id),
      ),
    );
    vms = vms.map((h) => ({
      ...h,
      vms: h.vms.filter(
        (v) => !unowned(v.id, v.meta?.creation) || again.has(v.id),
      ),
    }));
  }

  return {
    docker,
    api,
    agents,
    egress,
    gateways,
    firewall,
    failpoints,
    failpointsExpected: Boolean(opts.failpointsExpected),
    harnessExpected: Boolean(opts.harnessExpected),
    vms,
    hugepages: microvmNodes.length ? await readHugePages(host) : null,
    profiles: profileView(
      profileRows,
      cfg.profileStoreDir
        ? await readProfileStoreDir(cfg.profileStoreDir)
        : null,
    ),
  };
}

/**
 * Collect and check, retrying while the system settles: the invariants hold at rest, and a
 * teardown that has just been requested is allowed a few seconds to finish.
 */
export async function settledInvariants(
  check: (s: Snapshot) => { rule: string; detail: string }[],
  cfg: HostConfig = DEFAULT_HOST,
  opts: CollectOptions & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; violations: { rule: string; detail: string }[] }> {
  const until = Date.now() + (opts.timeoutMs ?? 30_000);
  let v: { rule: string; detail: string }[];
  for (;;) {
    try {
      v = check(await collectSnapshot(cfg, opts));
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
