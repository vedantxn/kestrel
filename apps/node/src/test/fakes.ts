import type Docker from "dockerode";
import {
  type ComputerRequest,
  type ComputerResponse,
  newId,
  type ConfigureRequest,
  type ConfigureResponse,
  type DenialsResponse,
  type EgressHealth,
  type EgressPolicy,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type ListPoliciesResponse,
  type RegisterRequest,
  type RegisterResponse,
  type ReportsRequest,
  type ReportsResponse,
  type RuntimeHealth,
  type StartRequest,
} from "@kestrel/contracts";
import { FakeClock, Failpoints, createLogger } from "@kestrel/shared";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeAgent, type AgentConfig, type ApiClient } from "../agent.js";
import type {
  ContainerInfo,
  DockerDriver,
  DockerEvent,
  Volumes,
} from "../docker.js";
import type { EgressClient } from "../egress-client.js";
import type { RuntimeClient } from "../runtime-client.js";
import { Store } from "../store.js";

export class FakeDocker implements DockerDriver {
  containers = new Map<string, ContainerInfo>();
  specs = new Map<string, Docker.ContainerCreateOptions>();
  removed: string[] = [];
  runCalls = 0;
  failRuns = 0;
  private next = 2;
  private listeners = new Set<(e: DockerEvent) => void>();

  constructor(private readonly clock: FakeClock) {}

  async run(spec: Docker.ContainerCreateOptions): Promise<ContainerInfo> {
    this.runCalls++;
    if (this.failRuns > 0) {
      this.failRuns--;
      throw new Error("docker: cannot create container");
    }
    const id = `c${this.runCalls.toString().padStart(4, "0")}${"0".repeat(56)}`;
    const info: ContainerInfo = {
      id,
      labels: (spec.Labels ?? {}) as Record<string, string>,
      running: true,
      address: `172.30.1.${this.next++}`,
      oomKilled: false,
      exitCode: null,
      createdAt: this.clock.now(),
    };
    this.containers.set(id, info);
    this.specs.set(id, spec);
    return { ...info };
  }
  async inspect(id: string) {
    const c = this.containers.get(id);
    return c ? { ...c } : null;
  }
  async remove(id: string) {
    if (this.containers.delete(id)) this.removed.push(id);
  }
  async list() {
    return [...this.containers.values()].map((c) => ({ ...c }));
  }
  onEvent(cb: (e: DockerEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The container dies by itself. */
  kill(id: string, opts: { oom?: boolean; exitCode?: number } = {}) {
    const c = this.containers.get(id);
    if (!c) return;
    c.running = false;
    c.oomKilled = Boolean(opts.oom);
    c.exitCode = opts.exitCode ?? (opts.oom ? 137 : 1);
    for (const l of this.listeners)
      l({ id, action: "die", exitCode: c.exitCode });
  }
  /** A container nothing knows about, as a crash could leave. */
  plant(
    labels: Record<string, string> = { "kestrel.node": "a" },
    ageMs = 60_000,
  ): string {
    const id = `planted${this.next}${"0".repeat(50)}`;
    this.containers.set(id, {
      id,
      labels,
      running: true,
      address: `172.30.1.${this.next++}`,
      oomKilled: false,
      exitCode: null,
      createdAt: this.clock.now() - ageMs,
    });
    return id;
  }
  byRole(role: string) {
    return [...this.containers.values()].filter(
      (c) => c.labels["kestrel.role"] === role,
    );
  }
}

export class FakeRuntime implements RuntimeClient {
  calls: { op: string; address: string }[] = [];
  configured = new Map<string, ConfigureRequest>();
  /** What configure does for an address: default ok. */
  behavior = new Map<string, "fail" | "badViewport" | "garbage">();
  /** Containers that never become ready. */
  neverReady = new Set<string>();
  failAllConfigures = false;

  constructor(private readonly docker: FakeDocker) {}

  private alive(address: string): boolean {
    return [...this.docker.containers.values()].some(
      (c) => c.address === address && c.running,
    );
  }

  async health(address: string): Promise<RuntimeHealth> {
    this.calls.push({ op: "health", address });
    if (!this.alive(address)) throw new Error("connection refused");
    const ready = !this.neverReady.has(address);
    return {
      protocolVersion: 1,
      status: ready ? "ready" : "starting",
      chromeReady: ready,
      chromeVersion: "154.0.8037.92",
    };
  }

  async configure(
    address: string,
    _token: string,
    req: ConfigureRequest,
  ): Promise<ConfigureResponse> {
    this.calls.push({ op: "configure", address });
    if (!this.alive(address)) throw new Error("connection refused");
    const b = this.behavior.get(address);
    if (b === "fail" || this.failAllConfigures) throw new Error("runtime: 500");
    if (b === "garbage") throw new Error("response did not match its schema");
    this.configured.set(address, req);
    const v =
      b === "badViewport"
        ? { width: req.viewport.width + 1, height: req.viewport.height }
        : req.viewport;
    return {
      viewport: v,
      deviceScaleFactor: 1,
      chromeVersion: "154.0.8037.92",
    };
  }

  async computer(
    address: string,
    _token: string,
    req: ComputerRequest,
  ): Promise<ComputerResponse> {
    this.calls.push({ op: `computer:${req.action}`, address });
    if (!this.alive(address)) throw new Error("connection refused");
    return { ok: true, width: 1280, height: 720, url: "about:blank" };
  }
  async stopRecording(address: string): Promise<void> {
    this.calls.push({ op: "stopRecording", address });
  }
}

export class FakeEgress implements EgressClient {
  policies = new Map<string, EgressPolicy>();
  restoredFlag = false;
  down = false;
  log: string[] = [];
  denialList: DenialsResponse["denials"] = [];
  denialEpoch = "e1";

  private check() {
    if (this.down) throw new Error("egress: connection refused");
  }
  async setPolicy(ip: string, p: EgressPolicy) {
    this.check();
    this.log.push(`set ${ip}`);
    this.policies.set(ip, p);
  }
  async clearPolicy(ip: string) {
    this.check();
    this.log.push(`clear ${ip}`);
    this.policies.delete(ip);
  }
  async list(): Promise<ListPoliciesResponse> {
    this.check();
    return {
      policies: [...this.policies].map(([ip, p]) => ({
        ip,
        sessionId: p.sessionId,
        ...(p.allow ? { allow: p.allow } : {}),
        deny: p.deny ?? [],
        connectionCap: p.connectionCap,
        openConnections: 0,
      })),
    };
  }
  async restored() {
    this.check();
    this.restoredFlag = true;
  }
  async health(): Promise<EgressHealth> {
    this.check();
    return {
      status: "ok",
      policiesRestored: this.restoredFlag,
      policyCount: this.policies.size,
    };
  }
  async denials(after: number): Promise<DenialsResponse> {
    this.check();
    return {
      epoch: this.denialEpoch,
      denials: this.denialList.filter((d) => d.seq > after),
    };
  }
  /** The egress gateway restarts: no policies, not restored. */
  restart() {
    this.policies.clear();
    this.restoredFlag = false;
  }
}

export class FakeApi implements ApiClient {
  down = false;
  epoch = 1;
  registered: RegisterRequest[] = [];
  heartbeats: HeartbeatRequest[] = [];
  reportBatches: ReportsRequest[] = [];
  /** What the next heartbeats answer. */
  reply: Partial<HeartbeatResponse> = {};
  async register(req: RegisterRequest): Promise<RegisterResponse> {
    if (this.down) throw new Error("api down");
    this.registered.push(req);
    return { epoch: this.epoch };
  }
  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    if (this.down) throw new Error("api down");
    this.heartbeats.push(req);
    return {
      epoch: this.epoch,
      fenced: false,
      stop: [],
      unknown: [],
      ...this.reply,
    };
  }
  async reports(req: ReportsRequest): Promise<ReportsResponse> {
    if (this.down) throw new Error("api down");
    this.reportBatches.push(req);
    return { acked: req.reports.map((r) => r.id) };
  }
  get allReports() {
    return this.reportBatches.flatMap((b) => b.reports);
  }
}

export class FakeHub {
  events: string[] = [];
  routes = new Map<string, unknown>();
  putRoute(r: { sessionId: string }) {
    this.events.push(`put ${r.sessionId}`);
    this.routes.set(r.sessionId, r);
  }
  removeRoute(id: string) {
    this.events.push(`remove ${id}`);
    this.routes.delete(id);
  }
}

export class FakeFirewall {
  ok = true;
  ensured = 0;
  /** After `ensure`, the rules are right again. */
  fixable = true;
  async verify() {
    return { ok: this.ok, problems: this.ok ? [] : ["chain is missing"] };
  }
  async ensure() {
    this.ensured++;
    if (this.fixable) this.ok = true;
  }
}

export interface Rig {
  agent: NodeAgent;
  clock: FakeClock;
  docker: FakeDocker;
  runtime: FakeRuntime;
  egress: FakeEgress;
  api: FakeApi;
  hub: FakeHub;
  firewall: FakeFirewall;
  store: Store;
  failpoints: Failpoints;
  config: AgentConfig;
  dbPath: string;
  volumes: FakeVolumes | undefined;
  /** A new agent process over the same durable store and the same world (a restart after a crash). */
  restart(): NodeAgent;
}

/** W3. Volumes as directories in a temporary folder, so recordings can be read back for real. */
export class FakeVolumes implements Volumes {
  root = mkdtempSync(join(tmpdir(), "vols-"));
  vols = new Map<string, number>();
  removed: string[] = [];
  failCreates = false;
  constructor(private readonly clock: FakeClock) {}
  async create(name: string) {
    if (this.failCreates) throw new Error("quota not supported");
    mkdirSync(join(this.root, name));
    this.vols.set(name, this.clock.now());
  }
  async remove(name: string) {
    if (this.vols.delete(name)) {
      this.removed.push(name);
      rmSync(join(this.root, name), { recursive: true, force: true });
    }
  }
  async list() {
    return [...this.vols].map(([name, createdAt]) => ({ name, createdAt }));
  }
  async path(name: string) {
    return this.vols.has(name) ? join(this.root, name) : null;
  }
}

export const SPEC = {
  nodeId: "a",
  image: "kestrel-runtime:test",
  network: "ksl-a",
  bridgeIp: "172.30.1.1",
  egressPort: 3128,
  cgroupParent: "kestrel.slice",
  seccompProfile: null,
};

export function makeRig(
  over: Partial<AgentConfig> = {},
  opts: {
    failpoints?: string;
    dbPath?: string;
    skipBoot?: boolean;
    volumes?: boolean;
  } = {},
): Rig {
  const clock = new FakeClock();
  const volumes = opts.volumes ? new FakeVolumes(clock) : undefined;
  const docker = new FakeDocker(clock);
  const runtime = new FakeRuntime(docker);
  const egress = new FakeEgress();
  const api = new FakeApi();
  const hub = new FakeHub();
  const firewall = new FakeFirewall();
  const dbPath =
    opts.dbPath ?? join(mkdtempSync(join(tmpdir(), "agent-")), "store.db");
  const store = new Store(dbPath);
  store.epoch = 1;
  const failpoints = new Failpoints(opts.failpoints, undefined, ((
    c: number,
  ) => {
    throw new Error(`exit ${c}`);
  }) as never);
  const config: AgentConfig = {
    nodeId: "a",
    slotsTotal: 4,
    poolTarget: 2,
    refillAtOnce: 2,
    address: "http://127.0.0.1:7001",
    runtimeVersion: "test",
    startRetries: 2,
    readyTimeoutMs: 1000,
    newContainerGraceMs: 15_000,
    ...over,
  };
  const build = (): NodeAgent =>
    new NodeAgent({
      config,
      store,
      docker,
      runtime,
      egress,
      firewall,
      hub,
      api,
      clock,
      log: createLogger("agent-test", "silent"),
      failpoints,
      dockerSpec: SPEC,
      ...(volumes ? { volumes } : {}),
    });
  const rig: Rig = {
    agent: build(),
    clock,
    docker,
    runtime,
    egress,
    api,
    hub,
    firewall,
    store,
    failpoints,
    config,
    dbPath,
    volumes,
    restart: () => (rig.agent = build()),
  };
  return rig;
}

export const ses = () => newId("ses");
export const prj = () => newId("prj");

export function startReq(over: Record<string, unknown> = {}) {
  return {
    sessionId: ses(),
    projectId: prj(),
    epoch: 1,
    viewport: { width: 1280, height: 720 },
    network: {},
    timeoutMs: 600_000,
    idleTimeoutMs: 300_000,
    stopOnDisconnect: false,
    ...over,
  } as StartRequest;
}

/** Boot and fill the pool, ready for hot starts. */
export async function bootWithPool(rig: Rig): Promise<void> {
  await rig.agent.boot();
  await rig.agent.refillPool();
  await rig.agent.idle();
}
