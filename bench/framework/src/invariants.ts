/**
 * H5, threat model G-05, G-10, G-16. One check that answers "is anything leaked or inconsistent":
 * it compares what Docker, the API's database, each node agent, the egress gateway, the gateways
 * and the firewall each say, and names every disagreement. It is a pure function over a snapshot,
 * so the comparison is tested exhaustively; the collectors that fill a snapshot from a real host
 * are separate (`collect.ts`).
 *
 * It runs after every benchmark and chaos case. Most failures it finds are leaks: a container,
 * a policy, a route or a slot that outlived its session.
 */

export interface DockerContainer {
  id: string;
  node: string | null;
  role: string | null;
  running: boolean;
  address: string | null;
  /** From `docker inspect`, for the hardening check (G-05). */
  config: {
    privileged: boolean;
    capAdd: string[];
    capDrop: string[];
    readonlyRootfs: boolean;
    user: string;
    pidsLimit: number | null;
    memory: number | null;
    memorySwap: number | null;
    nanoCpus: number | null;
    tmpfs: Record<string, string>;
    ports: number;
    binds: number;
    networkMode: string;
    noNewPrivileges: boolean;
  };
}

export interface ApiSession {
  id: string;
  status: string;
  nodeId: string | null;
  /** Seconds since it entered its current status. */
  ageSeconds: number;
}

export interface AgentView {
  node: string;
  slotsTotal: number;
  /** Warm browsers the pool may hold beyond the slots (agent POOL_HEADROOM). */
  poolHeadroom?: number;
  sessions: {
    sessionId: string;
    state: string;
    address: string | null;
    containerId: string | null;
  }[];
  pool: { containerId: string; address: string }[];
  pendingReports: number;
}

export interface EgressView {
  node: string;
  policies: { ip: string; sessionId: string }[];
  policiesRestored: boolean;
}

export interface GatewayView {
  node: string;
  routes: string[] | null;
  attachments: { sessionId: string; connections: number }[];
}

export interface Snapshot {
  docker: DockerContainer[];
  api: ApiSession[];
  agents: AgentView[];
  egress: EgressView[];
  gateways: GatewayView[];
  firewall: { node: string; ok: boolean; problems: string[] }[];
  /** Failpoints reported active by each API/agent process. */
  failpoints: { process: string; active: Record<string, string> }[];
  /** True while a test run has switched failpoints on on purpose. */
  failpointsExpected: boolean;
}

export interface Violation {
  /** Short stable name of the rule. */
  rule: string;
  detail: string;
}

const NON_TERMINAL = new Set([
  "requested",
  "scheduling",
  "starting",
  "ready",
  "active",
  "stopping",
]);
const MiB = 1024 * 1024;

export function checkInvariants(s: Snapshot): Violation[] {
  const v: Violation[] = [];
  const bad = (rule: string, detail: string): void =>
    void v.push({ rule, detail });

  const liveApi = s.api.filter((x) => NON_TERMINAL.has(x.status));
  const liveApiIds = new Set(liveApi.map((x) => x.id));
  const agentBindings = s.agents.flatMap((a) =>
    a.sessions.map((b) => ({ ...b, node: a.node })),
  );
  const agentSessionIds = new Set(agentBindings.map((b) => b.sessionId));
  const agentContainers = new Set(
    [
      ...agentBindings.map((b) => b.containerId),
      ...s.agents.flatMap((a) => a.pool.map((p) => p.containerId)),
    ].filter(Boolean) as string[],
  );

  // 1. The API and the agents agree on what is running.
  for (const a of liveApi) {
    if (a.status === "stopping") continue; // covered by the age rule below
    if (!agentSessionIds.has(a.id))
      bad(
        "api-session-without-binding",
        `${a.id} is ${a.status} in the API but no agent holds it`,
      );
  }
  for (const b of agentBindings) {
    if (!liveApiIds.has(b.sessionId))
      bad(
        "binding-without-api-session",
        `agent ${b.node} holds ${b.sessionId}, which the API shows ended or unknown`,
      );
  }
  for (const a of liveApi) {
    if (a.status === "stopping" && a.ageSeconds > 30)
      bad(
        "stuck-stopping",
        `${a.id} has been stopping for ${Math.round(a.ageSeconds)} s`,
      );
    if (
      ["requested", "scheduling", "starting"].includes(a.status) &&
      a.ageSeconds > 60
    )
      bad(
        "stuck-starting",
        `${a.id} has been ${a.status} for ${Math.round(a.ageSeconds)} s`,
      );
  }

  // 2. Every container is accounted for, and every session container is running.
  for (const c of s.docker) {
    if (!agentContainers.has(c.id))
      bad(
        "leaked-container",
        `container ${c.id.slice(0, 12)} (${c.role ?? "?"}) is not in any agent's store`,
      );
  }
  const dockerIds = new Set(s.docker.map((c) => c.id));
  for (const b of agentBindings) {
    if (b.containerId && !dockerIds.has(b.containerId))
      bad(
        "binding-without-container",
        `${b.sessionId} has no container ${b.containerId.slice(0, 12)} in Docker`,
      );
  }
  for (const a of s.agents) {
    for (const p of a.pool)
      if (!dockerIds.has(p.containerId))
        bad(
          "pool-without-container",
          `pooled ${p.containerId.slice(0, 12)} is not in Docker`,
        );
  }

  // 3. Egress policies belong to live sessions, and only to them (R15: a pooled browser has none).
  for (const e of s.egress) {
    const addrs = new Map(
      agentBindings
        .filter((b) => b.address)
        .map((b) => [b.address as string, b]),
    );
    for (const p of e.policies) {
      const b = addrs.get(p.ip);
      if (!b)
        bad(
          "leaked-egress-policy",
          `egress ${e.node} holds a policy for ${p.ip} (${p.sessionId}) that no session owns`,
        );
      else if (b.sessionId !== p.sessionId)
        bad(
          "egress-policy-wrong-session",
          `egress ${e.node}: ${p.ip} is ${p.sessionId} there but ${b.sessionId} on the agent`,
        );
    }
    for (const b of agentBindings.filter(
      (x) => x.node === e.node && x.state === "ready" && x.address,
    )) {
      if (!e.policies.some((p) => p.ip === b.address))
        bad(
          "ready-session-without-policy",
          `${b.sessionId} is ready on ${e.node} but ${b.address} has no egress policy (it would be refused everything)`,
        );
    }
    if (!e.policiesRestored)
      bad(
        "egress-not-restored",
        `egress ${e.node} reports its policies are not restored`,
      );
  }

  // 4. Gateways route only for ready sessions.
  for (const g of s.gateways) {
    if (g.routes) {
      for (const r of g.routes) {
        const b = agentBindings.find((x) => x.sessionId === r);
        if (!b || b.state !== "ready")
          bad(
            "leaked-route",
            `gateway ${g.node} routes ${r}, which is not a ready session`,
          );
      }
      for (const b of agentBindings.filter(
        (x) => x.node === g.node && x.state === "ready",
      )) {
        if (!g.routes.includes(b.sessionId))
          bad(
            "ready-session-without-route",
            `${b.sessionId} is ready on ${g.node} but gateway has no route`,
          );
      }
    }
    for (const a of g.attachments)
      if (!agentSessionIds.has(a.sessionId))
        bad(
          "attachment-without-session",
          `gateway ${g.node} holds ${a.connections} connection(s) to ${a.sessionId}, which no agent holds`,
        );
  }

  // 5. Slots and reports.
  for (const a of s.agents) {
    if (a.sessions.length > a.slotsTotal)
      bad(
        "slots-oversubscribed",
        `agent ${a.node} holds ${a.sessions.length} sessions in ${a.slotsTotal} slots`,
      );
    if (
      a.sessions.length + a.pool.length >
      a.slotsTotal + (a.poolHeadroom ?? 0)
    )
      bad(
        "pool-over-slots",
        `agent ${a.node}: ${a.sessions.length} sessions + ${a.pool.length} pooled > ${a.slotsTotal} slots + ${a.poolHeadroom ?? 0} headroom`,
      );
    if (a.pendingReports > 0)
      bad(
        "report-backlog",
        `agent ${a.node} has ${a.pendingReports} reports not yet acknowledged`,
      );
  }

  // 6. The firewall is as it must be (G17).
  for (const f of s.firewall)
    if (!f.ok)
      bad("firewall-drift", `node ${f.node}: ${f.problems.join("; ")}`);

  // 7. Failpoints are never silently on (G-16).
  if (!s.failpointsExpected) {
    for (const f of s.failpoints)
      if (Object.keys(f.active).length)
        bad(
          "failpoints-active",
          `${f.process} has failpoints on: ${JSON.stringify(f.active)}`,
        );
  }

  // 8. Every session container carries the hardened profile (G-05).
  for (const c of s.docker) {
    const w = (what: string) =>
      bad(
        "container-not-hardened",
        `${c.id.slice(0, 12)} (${c.role ?? "?"}): ${what}`,
      );
    const k = c.config;
    if (k.privileged) w("privileged");
    if (k.capAdd.length) w(`adds capabilities ${k.capAdd.join(",")}`);
    if (!k.capDrop.includes("ALL")) w("does not drop all capabilities");
    if (!k.noNewPrivileges) w("does not set no-new-privileges");
    if (!k.readonlyRootfs) w("has a writable root filesystem");
    if (k.user !== "10001:10001" && k.user !== "10001")
      w(`runs as ${k.user || "root"}`);
    if (!k.pidsLimit || k.pidsLimit > 1024)
      w(`process limit is ${k.pidsLimit}`);
    if (k.memory !== 2048 * MiB) w(`memory limit is ${k.memory}`);
    if (k.memorySwap !== k.memory) w("has swap");
    if (k.nanoCpus !== 1_000_000_000) w(`CPU limit is ${k.nanoCpus}`);
    for (const [path, opts] of Object.entries(k.tmpfs))
      if (!/noexec/.test(opts) || !/nosuid/.test(opts) || !/nodev/.test(opts))
        w(`${path} is not noexec,nosuid,nodev`);
    if (k.ports > 0) w("publishes ports");
    if (k.binds > 0) w("mounts host paths");
    if (!/^ksl-/.test(k.networkMode)) w(`is on network ${k.networkMode}`);
  }

  return v;
}
