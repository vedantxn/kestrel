import type Docker from "dockerode";
import {
  type ComputerRequest,
  type ComputerResponse,
  newId,
  type ConfigureRequest,
  type ConfigureResponse,
  type DenialsResponse,
  type EgressClearAck,
  type EgressHealth,
  type EgressUsageResponse,
  type EgressPolicy,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type ListPoliciesResponse,
  RECORDING_LIMITS,
  RecordingFragments,
  RUNTIME_PATHS,
  type RegisterRequest,
  type RegisterResponse,
  type ReportsRequest,
  type ReportsResponse,
  type ProbeRequest,
  type ProbeResponse,
  type CaptchaInjectRequest,
  type RuntimeCaptcha,
  type RuntimeCaptchaChallenges,
  type RuntimeCaptchaInject,
  type RuntimeHealth,
  type StartRequest,
  type LaunchRequest,
  type LaunchResponse,
  encodeProfileArchive,
} from "@kestrel/contracts";
import {
  FakeClock,
  Failpoints,
  FsProfileStore,
  createLogger,
  type Logger,
} from "@kestrel/shared";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeAgent,
  type AgentConfig,
  type AgentDeps,
  type ApiClient,
  type MicroVmHooks,
} from "../agent.js";
import type {
  ContainerInfo,
  DockerDriver,
  DockerEvent,
  Volumes,
} from "../docker.js";
import type { EgressClient } from "../egress-client.js";
import {
  RuntimeHttpError,
  type ProfileSaveAnswer,
  type ProfileWritten,
  type RuntimeClient,
} from "../runtime-client.js";
import { Store } from "../store.js";

export class FakeDocker implements DockerDriver {
  containers = new Map<string, ContainerInfo>();
  specs = new Map<string, Docker.ContainerCreateOptions>();
  removed: string[] = [];
  runCalls = 0;
  failRuns = 0;
  /**
   * While set, `run` makes the container (Docker lists it) and then waits on this before
   * answering, as a real create-and-start does; `remove` likewise waits on `removeGate`.
   */
  runGate: Promise<void> | null = null;
  removeGate: Promise<void> | null = null;
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
    if (this.runGate) await this.runGate;
    return { ...info };
  }
  async inspect(id: string) {
    const c = this.containers.get(id);
    return c ? { ...c } : null;
  }
  async remove(id: string) {
    if (this.removeGate) await this.removeGate;
    if (this.containers.delete(id)) this.removed.push(id);
  }
  paused = new Set<string>();
  async pause(id: string) {
    if (!this.containers.has(id)) throw new Error("no such container");
    this.paused.add(id);
  }
  listCalls = 0;
  async list() {
    this.listCalls++;
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
  behavior = new Map<
    string,
    "fail" | "badViewport" | "garbage" | "noTimezone"
  >();
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
    if (ready && this.waiting(address))
      return {
        protocolVersion: 1,
        status: "warm",
        chromeReady: false,
        chromeVersion: null,
      };
    return {
      protocolVersion: 1,
      status: ready ? "ready" : "starting",
      chromeReady: ready,
      chromeVersion: "154.0.8037.92",
    };
  }

  // --- P18: warm browsers and profiles ---------------------------------------------------------

  /** Addresses whose deferred Chrome has been launched. */
  launched = new Set<string>();
  /** Archives written into browsers, by address. */
  profiles = new Map<string, Buffer>();
  /** What `POST /launch` reports as the browser's Chrome. */
  chromeVersion = "Chrome/154.0.8037.92";
  /** How `POST /profile/save` answers, per address: default a small valid archive. */
  saveAnswers = new Map<
    string,
    ProfileSaveAnswer | "hang" | "fail" | (() => Promise<ProfileSaveAnswer>)
  >();
  saveCalls: string[] = [];
  /** `PUT /profile` refuses, per address. */
  putFails = new Set<string>();

  private specOf(address: string) {
    const c = [...this.docker.containers.values()].find(
      (x) => x.address === address,
    );
    return c ? this.docker.specs.get(c.id) : undefined;
  }
  /** A warm browser whose Chrome has not been launched yet. */
  waiting(address: string): boolean {
    return (
      !this.launched.has(address) &&
      (this.specOf(address)?.Env ?? []).includes("KESTREL_CHROME=deferred")
    );
  }

  async putProfile(
    address: string,
    _token: string,
    archive: Uint8Array,
  ): Promise<ProfileWritten> {
    this.calls.push({ op: "putProfile", address });
    if (!this.alive(address)) throw new Error("connection refused");
    if (!this.waiting(address) || this.profiles.has(address))
      throw new RuntimeHttpError(RUNTIME_PATHS.profile, 409);
    if (this.putFails.has(address))
      throw new RuntimeHttpError(RUNTIME_PATHS.profile, 400);
    this.profiles.set(address, Buffer.from(archive));
    return { files: 1, bytes: archive.length, cookies: 0 };
  }

  async launch(
    address: string,
    _token: string,
    req: LaunchRequest,
  ): Promise<LaunchResponse> {
    this.calls.push({
      op: `launch:${req.viewport.width}x${req.viewport.height}`,
      address,
    });
    if (!this.alive(address)) throw new Error("connection refused");
    if (!this.waiting(address))
      throw new RuntimeHttpError(RUNTIME_PATHS.launch, 409);
    this.launched.add(address);
    return { chromeVersion: this.chromeVersion, cookies: 0 };
  }

  async saveProfile(
    address: string,
    _token: string,
    _maxBytes: number,
    signal: AbortSignal,
  ): Promise<ProfileSaveAnswer> {
    this.calls.push({ op: "saveProfile", address });
    this.saveCalls.push(address);
    if (!this.alive(address)) throw new Error("connection refused");
    const a = this.saveAnswers.get(address);
    if (a === "fail") throw new Error("connection reset");
    if (a === "hang")
      return new Promise((_r, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    if (typeof a === "function") return a();
    return (
      a ?? {
        ok: true,
        body: encodeProfileArchive(
          [],
          [
            {
              path: "Default/LocalStorage",
              data: Buffer.from(`saved by ${address}`),
            },
          ],
        ),
      }
    );
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
    if (
      req.recording &&
      req.recordingSink === "pull" &&
      !this.guests.has(address)
    )
      this.guests.set(address, new FakeGuestRecording());
    const v =
      b === "badViewport"
        ? { width: req.viewport.width + 1, height: req.viewport.height }
        : req.viewport;
    return {
      viewport: v,
      deviceScaleFactor: 1,
      chromeVersion: "154.0.8037.92",
      // A runtimed from before time zones says nothing about them.
      ...(b === "noTimezone" ? {} : { timezone: req.timezone ?? null }),
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
  /** What `GET /captcha` answers per address: default nothing showing; null is an older runtimed. */
  captchaAnswers = new Map<string, RuntimeCaptcha | null | "fail">();
  async captcha(address: string): Promise<RuntimeCaptcha | null> {
    this.calls.push({ op: "captcha", address });
    if (!this.alive(address)) throw new Error("connection refused");
    const a = this.captchaAnswers.get(address);
    if (a === "fail") throw new Error("runtime /captcha: timed out");
    return a === undefined ? { watching: true, detections: [] } : a;
  }
  /** What `GET /captcha/challenges` answers per address: default none; null is an older runtimed. */
  challengeAnswers = new Map<
    string,
    RuntimeCaptchaChallenges | null | "fail"
  >();
  async captchaChallenges(
    address: string,
  ): Promise<RuntimeCaptchaChallenges | null> {
    this.calls.push({ op: "captchaChallenges", address });
    if (!this.alive(address)) throw new Error("connection refused");
    const a = this.challengeAnswers.get(address);
    if (a === "fail") throw new Error("runtime /captcha/challenges: timed out");
    return a === undefined ? { challenges: [] } : a;
  }
  /** Tokens put into pages, and what `/captcha/inject` answers. */
  injected: { address: string; req: CaptchaInjectRequest }[] = [];
  injectAnswer: RuntimeCaptchaInject | null = {
    result: "injected",
    callback: true,
  };
  async captchaInject(
    address: string,
    _token: string,
    req: CaptchaInjectRequest,
  ): Promise<RuntimeCaptchaInject | null> {
    this.calls.push({ op: "captchaInject", address });
    if (!this.alive(address)) throw new Error("connection refused");
    this.injected.push({ address, req });
    return this.injectAnswer;
  }
  async stopRecording(address: string): Promise<void> {
    this.calls.push({ op: "stopRecording", address });
    this.guests.get(address)?.stop();
  }

  /** microVMs' recorders (pull sink), by address: made when configure asks for one. */
  guests = new Map<string, FakeGuestRecording>();
  async recordingFragments(
    address: string,
    _token: string,
    after: number,
  ): Promise<{ meta: RecordingFragments; body: Buffer }> {
    this.calls.push({ op: `fragments:${after}`, address });
    if (!this.alive(address)) throw new Error("connection refused");
    const g = this.guests.get(address);
    const path = RUNTIME_PATHS.recordingFragments;
    if (!g || g.answer === "404") throw new RuntimeHttpError(path, 404);
    if (g.answer === "timeout") throw new Error(`runtime ${path}: timed out`);
    if (after < g.acked || after > g.made.length)
      throw new RuntimeHttpError(path, 409);
    g.acked = after;
    const out = g.made.slice(after, after + RECORDING_LIMITS.pullFragments);
    let got: { meta: RecordingFragments; body: Buffer } = {
      meta: {
        state: g.state,
        fragments: out.map((d, i) => ({ seq: after + 1 + i, bytes: d.length })),
        done: g.ended && after + out.length === g.made.length,
      } as RecordingFragments,
      body: Buffer.concat(out),
    };
    if (g.tamper) got = g.tamper(got);
    // What the real client checks before the agent sees it.
    return { meta: RecordingFragments.parse(got.meta), body: got.body };
  }
  /** What a probe VM's `/probe` answers: by default every target times out. */
  probeAnswer: ((req: ProbeRequest) => ProbeResponse) | null = null;
  async probe(address: string, _t: string, req: ProbeRequest) {
    this.calls.push({ op: "probe", address });
    if (!this.alive(address)) throw new Error("connection refused");
    return (
      this.probeAnswer?.(req) ?? {
        results: req.targets.map((t) => ({ name: t.name, result: "timeout" })),
      }
    );
  }
}

/** A VM's recorder as the agent sees it, scriptable: fragments it has made, and how it answers. */
export class FakeGuestRecording {
  made: Buffer[] = [];
  acked = 0;
  ended = false;
  state: RecordingFragments["state"] = "recording";
  answer: "ok" | "404" | "timeout" = "ok";
  /** A hostile guest rewrites its answers. */
  tamper?: (a: { meta: RecordingFragments; body: Buffer }) => {
    meta: RecordingFragments;
    body: Buffer;
  };
  /** Fragments the recorder writes as it stops (its last one, and the index). */
  onStop: Buffer[] = [];
  /** Recorder output: the init segment. */
  init(): this {
    this.made.push(Buffer.concat([mp4Box("ftyp", 20), mp4Box("moov", 700)]));
    return this;
  }
  media(n: number, body = 1000): this {
    for (let i = 0; i < n; i++)
      this.made.push(
        Buffer.concat([mp4Box("moof", 100), mp4Box("mdat", body, i + 1)]),
      );
    return this;
  }
  stop(): void {
    if (this.ended) return;
    this.made.push(...this.onStop);
    this.ended = true;
    this.state = "stopped";
  }
}

export const mp4Box = (type: string, body = 0, fill = 0): Buffer => {
  const b = Buffer.alloc(8 + body, fill);
  b.writeUInt32BE(8 + body, 0);
  b.write(type, 4, "latin1");
  return b;
};

export class FakeEgress implements EgressClient {
  policies = new Map<string, EgressPolicy>();
  restoredFlag = false;
  down = false;
  log: string[] = [];
  denialList: DenialsResponse["denials"] = [];
  denialEpoch = "e1";
  /** Bytes per address, as the gateway counts them (G-20). */
  bytes = new Map<string, { up: number; down: number }>();
  /** A gateway from before byte counters: no /v1/usage, and a bare 204 on clear. */
  noUsage = false;

  private check() {
    if (this.down) throw new Error("egress: connection refused");
  }
  /** Behave as a gateway from before upstream proxies: drop `upstream` and acknowledge nothing. */
  legacy = false;
  async setPolicy(ip: string, p: EgressPolicy) {
    this.check();
    this.log.push(`set ${ip}`);
    if (this.legacy) {
      const dropped = { ...p };
      delete dropped.upstream;
      this.policies.set(ip, dropped);
      return null;
    }
    this.policies.set(ip, p);
    return { sessionId: p.sessionId, upstream: p.upstream !== undefined };
  }
  async clearPolicy(ip: string): Promise<EgressClearAck | null> {
    this.check();
    this.log.push(`clear ${ip}`);
    const p = this.policies.get(ip);
    this.policies.delete(ip);
    const b = this.bytes.get(ip) ?? { up: 0, down: 0 };
    this.bytes.delete(ip);
    if (!p || this.noUsage) return null;
    return { sessionId: p.sessionId, epoch: this.denialEpoch, ...b };
  }
  async usage(): Promise<EgressUsageResponse> {
    this.check();
    if (this.noUsage) throw new Error("egress GET /v1/usage: 404");
    return {
      epoch: this.denialEpoch,
      sessions: [...this.policies].map(([ip, p]) => ({
        sessionId: p.sessionId,
        ...(this.bytes.get(ip) ?? { up: 0, down: 0 }),
      })),
    };
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
        ...(p.upstream
          ? {
              upstream: {
                ...(p.upstream.scheme ? { scheme: p.upstream.scheme } : {}),
                host: p.upstream.host,
                port: p.upstream.port,
                ...(p.upstream.username !== undefined
                  ? { username: p.upstream.username }
                  : {}),
              },
            }
          : {}),
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
    this.bytes.clear();
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
  /** P18: the profile store, when the rig has one. */
  profileStore: FsProfileStore | undefined;
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
    log?: Logger;
    harness?: boolean;
    microvm?: MicroVmHooks;
    solver?: AgentDeps["solver"];
    /** P18: a profile store in a fresh directory. */
    profiles?: boolean;
  } = {},
): Rig {
  const clock = new FakeClock();
  const volumes = opts.volumes ? new FakeVolumes(clock) : undefined;
  const profileStore = opts.profiles
    ? new FsProfileStore(mkdtempSync(join(tmpdir(), "agent-profiles-")))
    : undefined;
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
    // Off here so tests can see what was queued; pool.test.ts covers the immediate send.
    reportOnRemoval: false,
    // Off here so tests see a stopped session's container go at once; pool.test.ts covers deferral.
    deferRemoval: false,
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
      log: opts.log ?? createLogger("agent-test", "silent"),
      failpoints,
      dockerSpec: SPEC,
      ...(volumes ? { volumes } : {}),
      ...(opts.harness ? { harness: true } : {}),
      ...(opts.microvm ? { microvm: opts.microvm } : {}),
      ...(opts.solver ? { solver: opts.solver } : {}),
      ...(profileStore ? { profileStore } : {}),
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
    profileStore,
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
