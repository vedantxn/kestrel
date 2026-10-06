import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  LIMITS,
  NODE_PROTOCOL_VERSION,
  RECORDING_FILE,
  RECORDING_LIMITS,
  RUNTIME_PORTS,
  TIMINGS,
  captchaSet,
  type Attachment,
  type CaptchaProvider,
  type Report,
  type EgressPolicy,
  type StartNetwork,
  type UpstreamProxyView,
  type ComputerRequest,
  type ComputerResponse,
  type EndReason,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NodeState,
  type RegisterRequest,
  type RegisterResponse,
  type ReportsRequest,
  type ReportsResponse,
  type Route,
  type StartRequest,
  type StartResponse,
  type StopRequest,
  type StopResponse,
} from "@kestrel/contracts";
import {
  FailpointError,
  type Clock,
  type Failpoints,
  type Logger,
} from "@kestrel/shared";
import {
  buildContainerSpec,
  type ContainerInfo,
  type DockerDriver,
  type NodeConfigForDocker,
  type Role,
  type Volumes,
} from "./docker.js";
import type { EgressClient } from "./egress-client.js";
import type { Firewall } from "./firewall.js";
import type { GatewayHub } from "./gateway-hub.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { Binding, Store } from "./store.js";

/** The agent's calls to the API's internal listener (C4's repair path). */
export interface ApiClient {
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  reports(req: ReportsRequest): Promise<ReportsResponse>;
}

export interface AgentConfig {
  nodeId: string;
  slotsTotal: number;
  /** Hot browsers to keep ready, filled only from slots sessions are not using (G5). */
  poolTarget: number;
  refillAtOnce: number;
  /**
   * The pool grows past `poolTarget` to meet recent demand (starts in the last
   * DEMAND_WINDOW_MS), up to this many, and never into a slot a session needs. Default: slots.
   */
  poolMax?: number;
  /**
   * Extra containers the pool may hold beyond the slots. A slot reserves a session's full
   * memory (2 GB); an idle pooled browser uses a tenth of it, and sessions stay capped at the
   * slots, so a few warm browsers over the slots buy a deeper buffer for bursts at little cost.
   * Default 0 (the v1 rule: the pool only uses slots no session holds).
   */
  poolHeadroom?: number;
  /**
   * Retire a stopped session's container by freezing it (`docker pause`) and remove it later,
   * when no pooled browser is being made. Docker serializes container work, and a removal running
   * beside container creations made each creation 3-4 times slower: during a burst that starved
   * the pool. Bounded so nothing frozen outstays REAP_MAX_DELAY_MS, and at most REAP_MAX_QUEUE wait.
   * Default on.
   */
  deferRemoval?: boolean;
  /** The most a start waits for pooled browsers on their way (default WARM_WAIT_MS); tests shorten it. */
  warmWaitMs?: number;
  /** How many frozen containers may wait for removal at once (default REAP_MAX_QUEUE). */
  reapMaxQueue?: number;
  /**
   * How many pooled browsers carry a recording volume (W3). Only a session that records needs
   * one, and making and removing a volume for every browser added two Docker calls to each cycle;
   * a session that records and finds none hot starts cold with a fresh volume. Default 1.
   */
  recordingPool?: number;
  /** Send a session's `removed` report as soon as it is queued, not with the next heartbeat. Default on. */
  reportOnRemoval?: boolean;
  /** Where the API reaches this agent, sent at registration. */
  address: string;
  runtimeVersion: string;
  startRetries: number;
  readyTimeoutMs: number;
  /** A container younger than this is never judged unknown by reconciliation. */
  newContainerGraceMs: number;
}

export const DEFAULT_CONFIG: Omit<
  AgentConfig,
  "nodeId" | "slotsTotal" | "address"
> = {
  poolTarget: 2,
  refillAtOnce: 2,
  runtimeVersion: "dev",
  startRetries: 2,
  readyTimeoutMs: 30_000,
  newContainerGraceMs: 15_000,
};

export interface AgentDeps {
  config: AgentConfig;
  store: Store;
  docker: DockerDriver;
  runtime: RuntimeClient;
  egress: EgressClient;
  firewall: Pick<Firewall, "ensure" | "verify">;
  hub: Pick<GatewayHub, "putRoute" | "removeRoute">;
  api: ApiClient;
  clock: Clock;
  log: Logger;
  failpoints: Failpoints;
  dockerSpec: NodeConfigForDocker;
  /** W3. Recording volumes; without them sessions are not recorded. */
  volumes?: Volumes;
  /** The host's available memory in MiB, or undefined if unknown (deferred removal checks it). */
  memAvailableMb?: () => number | undefined;
}

/**
 * How long a start may wait for pooled browsers already on their way. A new container would join
 * the same Docker queue behind them, so it can only finish later: a start makes its own only
 * when none is on its way, or as a last resort past this bound (a refill that is stuck).
 */
const WARM_WAIT_MS = 15_000;

/** A frozen, stopped container is removed within this long even if the pool is still refilling. */
const REAP_MAX_DELAY_MS = 10_000;
/** At most this many frozen containers wait at once; past it, teardown removes at once. */
const REAP_MAX_QUEUE = 4;
/** Below this much available host memory, a stopped container is removed at once, not frozen. */
const REAP_MIN_FREE_MB = 4_096;

/** How far back starts count towards the pool's size. */
const DEMAND_WINDOW_MS = 10_000;

const hex = (n: number): string => randomBytes(n).toString("hex");

/**
 * The node agent (G1-G16): the one component with Docker and firewall rights, and the authority
 * on what runs on its node. Everything it decides is written to its durable store first, so a
 * crash at any step leaves a state that boot recovery (G9) and reconciliation (G13) can finish
 * or undo. The control plane's view is repaired from here by heartbeats; this component never
 * relies on the control plane being up to keep a session running (principle 5).
 */
export class NodeAgent {
  private readonly c: AgentConfig;
  private firewallOk = false;
  private inflight = new Map<string, Promise<StartResponse>>();
  private teardowns = new Map<string, Promise<void>>();
  private poolStarting = new Map<string, Promise<boolean>>();
  private tasks = new Set<Promise<unknown>>();
  /** Pooled browsers being created, not yet in the store: counted so a second refill cannot over-fill the pool. */
  private spawning = 0;
  /** Of `spawning`, how many are being made with a recording volume. */
  private spawningWithVolume = 0;
  /** A reconcile asked for by a container event while one was running: run once more after it. */
  private reconcileAgain = false;
  private reconciling: Promise<void> | null = null;
  /** When recent starts arrived, for the demand-sized pool. */
  private recentStarts: number[] = [];
  /** Pooled browsers being made, from the first Docker call until they are hot (or failed). */
  private makingPool = new Set<Promise<boolean>>();
  /** Each container's recording volume, as made here: saves a Docker call per teardown (a restart falls back to inspect). */
  private volumeOf = new Map<string, string>();
  /** Stopped sessions' containers, frozen and waiting to be removed (deferRemoval). */
  private reapQueue: { id: string; volume?: string; at: number }[] = [];
  private reaping = false;
  /** Where a start's time went (performance.now() marks), logged when a start is slow. */
  private startMarks = new Map<string, [string, number][]>();
  private mark(sessionId: string, phase: string): void {
    this.startMarks.get(sessionId)?.push([phase, performance.now()]);
  }
  /** When a stuck teardown may next be retried. */
  private retryAt = new Map<string, number>();
  private syncing: Promise<void> | null = null;
  private gatewayAttachments = new Map<string, Map<string, number>>();
  private denialCursor = { epoch: "", seq: 0 };
  private timers: NodeJS.Timeout[] = [];
  private booted = false;

  constructor(private readonly d: AgentDeps) {
    this.c = d.config;
  }

  private get store(): Store {
    return this.d.store;
  }
  private now(): number {
    return this.d.clock.now();
  }

  /** Run something in the background and remember it, so tests and shutdown can wait for it. */
  private spawn<T>(p: Promise<T>): void {
    this.tasks.add(p);
    void p.catch(() => undefined).finally(() => this.tasks.delete(p));
  }

  /** Wait for background work to finish (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (
      this.tasks.size > 0 ||
      this.teardowns.size > 0 ||
      this.inflight.size > 0
    ) {
      await Promise.allSettled([
        ...this.tasks,
        ...this.teardowns.values(),
        ...this.inflight.values(),
      ]);
    }
  }

  // --- numbers --------------------------------------------------------------------------------

  private sessionCount(): number {
    return this.store.allBindings().length;
  }

  describe(): NodeState {
    const bindings = this.store.allBindings();
    const hot = this.store.allPool().filter((p) => p.state === "hot").length;
    return {
      nodeId: this.c.nodeId as NodeState["nodeId"],
      epoch: this.store.epoch,
      protocolVersion: NODE_PROTOCOL_VERSION,
      // The pool yields to sessions, so a slot is free if no session holds it (G4, G5, K2).
      slots: {
        total: this.c.slotsTotal,
        free: Math.max(0, this.c.slotsTotal - bindings.length),
      },
      hotCount: hot,
      sessions: bindings.map((b) => ({
        sessionId: b.sessionId as NodeState["sessions"][number]["sessionId"],
        state: b.state,
      })),
      pendingReports: this.store.pendingReportCount(),
    };
  }

  /** Everything the agent holds, for the invariant checker (H5). Authenticated like the rest of the node protocol. */
  state(): {
    sessions: {
      sessionId: string;
      state: string;
      address: string | null;
      containerId: string | null;
    }[];
    pool: { containerId: string; address: string; state: string }[];
    pendingReports: number;
    slotsTotal: number;
    poolHeadroom: number;
    retiring: string[];
    admitting: boolean;
    failpoints: Record<string, string>;
  } {
    return {
      sessions: this.store.allBindings().map((b) => ({
        sessionId: b.sessionId,
        state: b.state,
        address: b.address,
        containerId: b.containerId,
      })),
      pool: this.store.allPool().map((p) => ({
        containerId: p.containerId,
        address: p.address,
        state: p.state,
      })),
      pendingReports: this.store.pendingReportCount(),
      slotsTotal: this.c.slotsTotal,
      poolHeadroom: this.c.poolHeadroom ?? 0,
      retiring: this.reapQueue.map((q) => q.id),
      admitting: this.firewallOk,
      failpoints: this.d.failpoints.describe(),
    };
  }

  // --- boot (G9, I13, G17) --------------------------------------------------------------------

  /**
   * Boot is routine: the nightly stop makes every morning a host reboot (I13). In order: the
   * firewall is verified before any container exists; leftovers of a crash are torn down, never
   * resumed (G9); containers that are not ours to keep are removed; policies are pushed back to
   * the egress gateway; then the agent registers with the API and the loops begin.
   */
  async boot(): Promise<void> {
    await this.checkFirewall();
    const now = this.now();

    for (const b of this.store.allBindings()) {
      if (b.state === "stopping") {
        this.spawn(this.teardown(b.sessionId, b.stopReason ?? "runtime_crash"));
      } else if (b.state === "starting") {
        // Its true state is unknowable: tear it down, never resume it (G9).
        this.spawn(this.teardown(b.sessionId, "runtime_crash"));
      } else {
        // A ready session survives an agent restart. What is attached comes from the gateways: any that
        // said hello before boot finished are already counted (they will not say it again), and the idle
        // clock restarts only for sessions nobody is attached to.
        const n = this.attachmentTotals().get(b.sessionId) ?? 0;
        this.store.updateBinding(b.sessionId, {
          attached: n,
          idleAt: n > 0 ? null : now + b.idleTimeoutMs,
        });
      }
    }
    // A pooled browser left `starting` by a crash was never waited on and never will be: remove it.
    for (const p of this.store
      .allPool()
      .filter((p) => p.state === "starting")) {
      this.store.deletePool(p.containerId);
      await this.d.docker.remove(p.containerId).catch(() => undefined);
    }
    await this.idle();
    await this.reconcile();
    // A deploy may have lowered the pool's size: hot browsers past it are left over, not wanted.
    const keep = Math.max(
      this.c.poolTarget,
      this.c.recordingPool ?? (this.d.volumes ? 1 : 0),
    );
    const hot = this.store.allPool().filter((p) => p.state === "hot");
    for (const p of this.c.poolTarget === 0 ? hot : hot.slice(keep)) {
      if (!this.store.takePool(p.containerId)) continue;
      const vol = this.volumeOf.get(p.containerId);
      this.volumeOf.delete(p.containerId);
      await this.removeWithVolume(p.containerId, vol);
    }
    await this.syncEgress();
    this.booted = true;
  }

  async register(): Promise<void> {
    const res = await this.d.api.register({
      nodeId: this.c.nodeId as RegisterRequest["nodeId"],
      epoch: this.store.epoch,
      slotsTotal: this.c.slotsTotal,
      address: this.c.address,
      runtimeVersion: this.c.runtimeVersion,
    });
    this.store.epoch = res.epoch;
  }

  /** The routes of every ready session, for a gateway that has just connected. */
  routes(): Route[] {
    return this.store
      .allBindings()
      .filter((b) => b.state === "ready" && b.address && b.proof)
      .map((b) => this.routeFor(b));
  }

  private routeFor(b: Binding): Route {
    return {
      sessionId: b.sessionId as Route["sessionId"],
      projectId: b.projectId as Route["projectId"],
      address: b.address as string,
      port: RUNTIME_PORTS.cdpForward,
      proof: b.proof as string,
      // The route stops serving at the deadline whether or not the agent says so.
      notAfter: Math.ceil(b.maxAt / 1000) + 5,
    };
  }

  // --- start (G6, G7, G8) ---------------------------------------------------------------------

  async start(req: StartRequest): Promise<StartResponse> {
    const id = req.sessionId as string;
    if (req.epoch !== this.store.epoch)
      return {
        result: "refused",
        reason: `stale epoch ${req.epoch}, node is at ${this.store.epoch}`,
      };
    if (!this.firewallOk)
      return {
        result: "refused",
        reason: "the firewall rules are not verified",
      };

    const existing = this.store.getBinding(id);
    if (existing) {
      // A repeated start (the API retried a lost answer): answer from what exists.
      if (existing.state === "ready")
        return {
          result: "ready",
          startPath: existing.startPath ?? "hot",
          readyMs: 0,
          deviceScaleFactor: 1,
        };
      const pending = this.inflight.get(id);
      if (pending) return pending;
      return { result: "refused", reason: `session is ${existing.state}` };
    }
    // A stop that arrived before its start closes the delayed-start race (G14).
    if (this.store.isStopRemembered(id, this.now()))
      return { result: "refused", reason: "stop already received" };
    if (this.sessionCount() >= this.c.slotsTotal)
      return { result: "refused", reason: "no slot" };

    const t0 = this.now();
    this.store.insertBinding({
      sessionId: id,
      projectId: req.projectId as string,
      state: "starting",
      containerId: null,
      address: null,
      proof: null,
      controlToken: null,
      policy: req.network,
      viewport: req.viewport,
      stopOnDisconnect: req.stopOnDisconnect,
      timeoutMs: req.timeoutMs,
      idleTimeoutMs: req.idleTimeoutMs,
      createdAt: t0,
      readyAt: null,
      maxAt: t0 + req.timeoutMs, // absolute, on this agent's clock (G11)
      idleAt: null,
      attached: 0,
      stopReason: null,
      startPath: null,
    });
    await this.d.failpoints.hit("node.start.after_binding");

    const p = this.doStart(id, req, t0);
    this.inflight.set(id, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(id);
    }
  }

  private aborted(id: string): boolean {
    const b = this.store.getBinding(id);
    return !b || b.state === "stopping";
  }

  private async doStart(
    id: string,
    req: StartRequest,
    t0: number,
  ): Promise<StartResponse> {
    let lastError = "unknown";
    for (let attempt = 0; attempt <= this.c.startRetries; attempt++) {
      let held: { containerId: string; address: string } | null = null;
      try {
        this.startMarks.set(id, [["begin", performance.now()]]);
        // `acquire` has already recorded the container against the binding.
        const got = await this.acquire(id, Boolean(req.recording));
        this.mark(id, `acquired:${got.path}`);
        held = { containerId: got.containerId, address: got.address };
        await this.d.failpoints.hit("node.start.after_acquire");
        if (this.aborted(id)) throw new StartAborted();

        // The policy exists before the browser is usable (G7).
        await this.applyPolicy(got.address, id, req.network);
        await this.d.failpoints.hit("node.start.after_policy");

        // W3. Recorded only if the container has a volume. The volume is kept from now on, so even a
        // start that fails later leaves nothing unaccounted for: retention removes it.
        let recording = false;
        if (req.recording) {
          const volume =
            this.volumeOf.get(got.containerId) ??
            (await this.d.docker.inspect(got.containerId))?.labels[
              "kestrel.volume"
            ];
          if (volume) {
            this.store.addRecording(id, volume, this.now());
            recording = true;
          }
        }

        // Configuring the container is also its health check: a browser that cannot apply it never gets a route.
        const proof = hex(32);
        this.mark(id, "policy");
        const cfg = await this.d.runtime.configure(got.address, got.token, {
          sessionProof: proof as never,
          viewport: req.viewport,
          recording,
          recordingSink: "volume",
        });
        // The container is untrusted: check that what it reports is what was asked (A6).
        if (
          cfg.viewport.width !== req.viewport.width ||
          cfg.viewport.height !== req.viewport.height
        ) {
          throw new Error(
            `the browser reports a ${cfg.viewport.width}x${cfg.viewport.height} viewport, not the requested one`,
          );
        }
        this.store.updateBinding(id, { proof });
        await this.d.failpoints.hit("node.start.after_configure");
        if (this.aborted(id)) throw new StartAborted();

        const b = this.store.getBinding(id) as Binding;
        this.d.hub.putRoute(this.routeFor(b));
        await this.d.failpoints.hit("node.start.before_ready");
        if (this.aborted(id)) throw new StartAborted();

        const ready = this.now();
        this.mark(id, "configured");
        this.logSlowStart(id);
        this.store.updateBinding(id, {
          state: "ready",
          readyAt: ready,
          idleAt: ready + req.idleTimeoutMs,
        });
        return {
          result: "ready",
          startPath: got.path,
          readyMs: ready - t0,
          deviceScaleFactor: cfg.deviceScaleFactor,
        };
      } catch (e) {
        // A process that dies at a failpoint leaves its state exactly as it is: no cleanup here.
        if (e instanceof FailpointError) throw e;
        if (e instanceof StartAborted) {
          // Stopped while starting. The stop's teardown may have run before this container was
          // recorded, so this start removes what it holds: nothing else will.
          if (held) {
            await this.d.egress
              .clearPolicy(held.address)
              .catch(() => undefined);
            await this.d.docker.remove(held.containerId).catch(() => undefined);
            this.d.hub.removeRoute(id);
          }
          return { result: "failed", reason: "stopped while starting" };
        }
        lastError = e instanceof Error ? e.message : String(e);
        this.d.log.warn(
          { session: id, attempt, err: lastError },
          "start attempt failed",
        );
        // A dead pooled browser never reaches a client (G8): clear the policy, drop the container, try the next.
        if (held) {
          await this.d.egress.clearPolicy(held.address).catch(() => undefined);
          await this.d.docker.remove(held.containerId).catch(() => undefined);
          this.store.updateBinding(id, {
            containerId: null,
            address: null,
            controlToken: null,
            proof: null,
          });
          this.d.hub.removeRoute(id);
        }
        if (this.aborted(id))
          return { result: "failed", reason: "stopped while starting" };
        // Another browser would meet the same gateway: do not spend the pool on it.
        if (e instanceof EgressUnsupported) break;
      }
    }
    this.startMarks.delete(id);
    this.store.deleteBinding(id);
    return { result: "failed", reason: lastError };
  }

  // --- containers and the pool (G5, G6) -------------------------------------------------------

  /**
   * An admitted start is never refused for lack of a pooled browser (G6): take a hot one; else
   * wait for one that is still starting; else make one. The last two are the cold path.
   */
  private async acquire(
    sessionId: string,
    recording = false,
  ): Promise<{
    containerId: string;
    address: string;
    token: string;
    path: "hot" | "cold";
  }> {
    this.recentStarts.push(this.now());
    // The container is recorded against the session the moment it is ours, before anything slow:
    // reconciliation must never be able to judge a container that a start is still waiting on.
    const bind = (
      containerId: string,
      address: string,
      token: string,
      path: "hot" | "cold",
    ) => {
      this.store.updateBinding(sessionId, {
        containerId,
        address,
        controlToken: token,
        startPath: path,
      });
      return { containerId, address, token, path };
    };

    // A hot one. `takePool` succeeds for exactly one caller, so two starts can never share a container.
    // A session that records needs a browser with a volume; one that does not leaves those for it.
    const takeHot = async (path: "hot" | "cold") => {
      const hot = this.store
        .allPool()
        .filter((p) => p.state === "hot")
        .filter((p) => !recording || this.volumeOf.has(p.containerId))
        .sort(
          (a, b) =>
            Number(this.volumeOf.has(a.containerId)) -
            Number(this.volumeOf.has(b.containerId)),
        );
      for (const p of hot) {
        if (!this.store.takePool(p.containerId)) continue;
        void this.refillPool();
        const taken = bind(p.containerId, p.address, p.controlToken, path);
        // Still alive? Asked of the browser itself, not the Docker daemon, which serializes
        // container work: an inspect here queued behind the pool's creations under load.
        const alive = await this.d.runtime
          .health(p.address, p.controlToken)
          .then(
            (h) => h.status === "ready" && h.chromeReady,
            () => false,
          );
        if (alive) return taken;
        this.store.updateBinding(sessionId, {
          containerId: null,
          address: null,
          controlToken: null,
          startPath: null,
        });
        await this.d.docker.remove(p.containerId).catch(() => undefined);
      }
      return null;
    };
    const hot = await takeHot("hot");
    if (hot) return hot;

    // None hot, some warming: take whichever is ready first, checking again after each one
    // finishes (another start may have taken it, or a different one may be ready). Waiting on
    // them one after another instead added up to 10 s under load. Bounded: past the bound a
    // fresh container is no slower than continuing to wait.
    // A session that records takes only a browser with a volume, and the pool keeps few of those:
    // it starts cold with its own rather than wait on browsers it could not take.
    const until =
      performance.now() + (recording ? 0 : (this.c.warmWaitMs ?? WARM_WAIT_MS));
    for (;;) {
      const warming = [
        ...this.makingPool,
        ...this.store
          .allPool()
          .filter((p) => p.state === "starting")
          .map((p) => this.poolStarting.get(p.containerId))
          .filter((w): w is Promise<boolean> => w !== undefined),
      ];
      const left = until - performance.now();
      if (warming.length === 0 || left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        ...warming,
        new Promise((r) => (timer = setTimeout(r, left))),
      ]);
      clearTimeout(timer);
      const got = await takeHot("cold");
      if (got) return got;
    }
    // Cold. Free a slot's worth of pool first if the pool is using the room: sessions have priority.
    const spare =
      this.c.slotsTotal + (this.c.poolHeadroom ?? 0) - this.sessionCount();
    const pool = this.store.allPool();
    if (pool.length > Math.max(0, spare - 1)) {
      const victim = pool[pool.length - 1];
      if (victim && this.store.takePool(victim.containerId)) {
        this.d.log.info(
          {
            container: victim.containerId.slice(0, 12),
            pool: pool.length,
            spare,
          },
          "pool: evicted to make room for a cold start",
        );
        // Off the start's path: freeze it for the reaper, or remove it in the background.
        const vol = this.volumeOf.get(victim.containerId);
        this.volumeOf.delete(victim.containerId);
        if (!(await this.deferRemoval(victim.containerId, vol)))
          this.spawn(this.removeWithVolume(victim.containerId, vol));
      }
    }
    const snap = this.store.allPool();
    this.d.log.info(
      {
        session: sessionId,
        hot: snap.filter((p) => p.state === "hot").length,
        starting: snap.filter((p) => p.state === "starting").length,
        withPromise: snap.filter((p) => this.poolStarting.has(p.containerId))
          .length,
        spawning: this.spawning,
      },
      "pool: going cold",
    );
    this.mark(sessionId, "cold:begin");
    const created = await this.createContainer("session", recording);
    this.mark(sessionId, "cold:created");
    const info = created.info;
    const bound = bind(info.id, info.address as string, created.token, "cold");
    const isReady = await this.waitReady(info.address as string, created.token);
    this.mark(sessionId, "cold:ready");
    if (!isReady) {
      this.store.updateBinding(sessionId, {
        containerId: null,
        address: null,
        controlToken: null,
        startPath: null,
      });
      await this.d.docker.remove(info.id).catch(() => undefined);
      throw new Error("the browser did not become ready");
    }
    return bound;
  }

  private async createContainer(
    role: Role,
    withVolume: boolean,
  ): Promise<{ info: ContainerInfo; token: string }> {
    const token = hex(24);
    const volume = withVolume ? await this.makeRecordingVolume() : undefined;
    let info: ContainerInfo;
    try {
      info = await this.d.docker.run(
        buildContainerSpec(this.d.dockerSpec, role, token, volume),
      );
    } catch (e) {
      if (volume) await this.d.volumes?.remove(volume).catch(() => undefined);
      throw e;
    }
    if (!info.address) {
      await this.d.docker.remove(info.id).catch(() => undefined);
      throw new Error("the container has no address on the session network");
    }
    if (volume) this.volumeOf.set(info.id, volume);
    return { info, token };
  }

  /**
   * Wait until the container's browser answers; "hot" must mean truly ready (R5). Once runtimed
   * listens, its health call is held until the browser is ready, so the agent learns it at once;
   * until then (and with an older runtimed) it polls briefly.
   */
  private async waitReady(address: string, token: string): Promise<boolean> {
    const until = this.now() + this.c.readyTimeoutMs;
    for (;;) {
      const left = until - this.now();
      try {
        const h = await this.d.runtime.health(
          address,
          token,
          2000,
          Math.max(0, Math.min(5_000, left)),
        );
        if (h.status === "ready" && h.chromeReady) return true;
        if (h.status === "failed") return false;
      } catch {
        /* not up yet */
      }
      if (this.now() > until) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * The pool size wanted now: at least `poolTarget`, and as many as the starts of the last
   * DEMAND_WINDOW_MS, so a burst finds hot browsers rather than one per `poolTarget`. Capped by
   * `poolMax`; the caller also caps it by the room sessions leave.
   */
  private poolWanted(): number {
    if (this.c.poolTarget === 0) return 0; // pooling is switched off: demand does not switch it on
    const now = this.now();
    this.recentStarts = this.recentStarts.filter(
      (t) => now - t < DEMAND_WINDOW_MS,
    );
    return Math.min(
      this.c.poolMax ?? this.c.slotsTotal + (this.c.poolHeadroom ?? 0),
      Math.max(this.c.poolTarget, this.recentStarts.length),
    );
  }

  /**
   * Top the pool up from slots no session is using, a few at a time (G5). Runs every second, and
   * at once when a pooled browser is taken or a session ends, so its replacement starts warming
   * while the next request is still on its way rather than up to a second later.
   */
  async refillPool(): Promise<void> {
    if (!this.firewallOk || !this.booted) return;
    const have = this.store.allPool().length + this.spawning;
    const room =
      this.c.slotsTotal +
      (this.c.poolHeadroom ?? 0) -
      this.sessionCount() -
      have;
    // `refillAtOnce` caps how many are in flight at once (being created, or created and still
    // warming), not how many each call may add: refills run every second and after every take, so
    // a per-call cap let up to the whole pool be created together, which stalled Docker for
    // seconds per container and slowed the very starts the pool exists to serve.
    const inFlight =
      this.spawning +
      this.store.allPool().filter((p) => p.state === "starting").length;
    const want = Math.min(
      this.poolWanted() - have,
      this.c.refillAtOnce - inFlight,
      room,
    );
    for (let i = 0; i < want; i++) {
      this.spawning++;
      const withVolume =
        this.d.volumes !== undefined &&
        this.store.allPool().filter((p) => this.volumeOf.has(p.containerId))
          .length +
          this.spawningWithVolume <
          (this.c.recordingPool ?? 1);
      if (withVolume) this.spawningWithVolume++;
      // Waitable from the moment it begins, not only once Docker has made the container: a start
      // finding the pool empty waits for whichever of these is ready first.
      const made = this.spawnPooled(withVolume);
      this.makingPool.add(made);
      void made.finally(() => this.makingPool.delete(made));
      this.spawn(made.then(() => undefined));
    }
  }

  /** Resolves true once the new pooled browser is hot (and in the pool), false if it never is. */
  private async spawnPooled(withVolume: boolean): Promise<boolean> {
    let created: { info: ContainerInfo; token: string };
    try {
      created = await this.createContainer("pool", withVolume);
    } catch (e) {
      this.spawning--;
      if (withVolume) this.spawningWithVolume--;
      this.d.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not create a pooled browser",
      );
      return false;
    }
    const { info, token } = created;
    this.store.upsertPool({
      containerId: info.id,
      address: info.address as string,
      controlToken: token,
      state: "starting",
      createdAt: this.now(),
    });
    this.spawning--;
    if (withVolume) this.spawningWithVolume--;
    const ready = this.waitReady(info.address as string, token).then(
      async (ok) => {
        if (ok && this.store.allPool().some((p) => p.containerId === info.id)) {
          this.store.upsertPool({
            containerId: info.id,
            address: info.address as string,
            controlToken: token,
            state: "hot",
            createdAt: this.now(),
          });
          return true;
        }
        // Either it never became ready, or a session took it while it was starting.
        if (this.store.allPool().some((p) => p.containerId === info.id)) {
          this.d.log.info(
            { container: info.id.slice(0, 12), ok },
            "pool: dropped a browser that did not become ready",
          );
          this.store.deletePool(info.id);
          await this.d.docker.remove(info.id).catch(() => undefined);
        }
        return false;
      },
    );
    this.poolStarting.set(info.id, ready);
    const ok = await ready;
    this.poolStarting.delete(info.id);
    return ok;
  }

  /**
   * Freeze a stopped session's container and queue it for removal (see `deferRemoval`). Its route
   * and egress policy are already gone, so a frozen container is unreachable and has no way out;
   * its address stays taken until it is removed. False when it must be removed now instead.
   */
  private async deferRemoval(id: string, volume?: string): Promise<boolean> {
    if (
      !(this.c.deferRemoval ?? true) ||
      this.reapQueue.length >= (this.c.reapMaxQueue ?? REAP_MAX_QUEUE)
    )
      return false;
    // A frozen container keeps its memory until it is removed: defer only while the host has room.
    const free = this.d.memAvailableMb?.();
    if (free !== undefined && free < REAP_MIN_FREE_MB) return false;
    try {
      await this.d.docker.pause(id);
    } catch {
      return false; // already dead, or the pause failed: remove it the ordinary way
    }
    this.reapQueue.push({
      id,
      ...(volume ? { volume } : {}),
      at: performance.now(),
    });
    return true;
  }

  private async removeWithVolume(id: string, volume?: string): Promise<void> {
    await this.d.docker.remove(id).catch(() => undefined);
    if (volume) await this.d.volumes?.remove(volume).catch(() => undefined);
  }

  /** Remove frozen containers one at a time: when nothing is being made, or one has waited too long. */
  async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      for (;;) {
        const oldest = this.reapQueue[0];
        if (!oldest) return;
        const quiet = this.makingPool.size === 0 && this.spawning === 0;
        const overdue = performance.now() - oldest.at > REAP_MAX_DELAY_MS;
        if (!quiet && !overdue) return;
        await this.d.docker.remove(oldest.id).catch((e: unknown) =>
          this.d.log.warn(
            {
              container: oldest.id.slice(0, 12),
              err: e instanceof Error ? e.message : String(e),
            },
            "could not remove a retired container; reconciliation will",
          ),
        );
        if (oldest.volume)
          await this.d.volumes?.remove(oldest.volume).catch(() => undefined);
        this.reapQueue.shift();
      }
    } finally {
      this.reaping = false;
    }
  }

  /** A start slower than 2 s is logged with the time each phase took, to find what the tail is made of. */
  private logSlowStart(id: string): void {
    const marks = this.startMarks.get(id);
    this.startMarks.delete(id);
    if (!marks || marks.length < 2) return;
    const total = marks[marks.length - 1]![1] - marks[0]![1];
    if (total < 2_000) return;
    const phases: Record<string, number> = {};
    for (let i = 1; i < marks.length; i++)
      phases[marks[i]![0]] = Math.round(marks[i]![1] - marks[i - 1]![1]);
    this.d.log.warn(
      {
        session: id,
        totalMs: Math.round(total),
        phases,
        pool: this.store.allPool().length,
        hot: this.store.allPool().filter((p) => p.state === "hot").length,
        spawning: this.spawning,
        sessions: this.sessionCount(),
      },
      "slow start",
    );
  }

  // --- stop (G10, G14) ------------------------------------------------------------------------

  /**
   * W4. One `/computer` action on a running session's page. It counts as activity (HLD 4.1):
   * a session nobody is attached to has its idle deadline pushed back.
   */
  async computer(
    sessionId: string,
    req: ComputerRequest,
  ): Promise<
    | { ok: true; response: ComputerResponse }
    | { ok: false; status: 404 | 409 | 502; error: string }
  > {
    const b = this.store.getBinding(sessionId);
    if (!b) return { ok: false, status: 404, error: "no such session" };
    if (b.state !== "ready" || !b.address || !b.controlToken)
      return { ok: false, status: 409, error: "the session is not running" };
    if (b.idleAt !== null)
      this.store.updateBinding(sessionId, {
        idleAt: this.now() + b.idleTimeoutMs,
      });
    try {
      return {
        ok: true,
        response: await this.d.runtime.computer(b.address, b.controlToken, req),
      };
    } catch (e) {
      return {
        ok: false,
        status: 502,
        error: `the browser did not complete the action: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`,
      };
    }
  }

  async stop(req: StopRequest): Promise<StopResponse> {
    const id = req.sessionId as string;
    const b = this.store.getBinding(id);
    if (!b) {
      // A stop for a session never seen is remembered, so a start arriving later is refused (G14).
      // "Gone" counts as confirmation.
      this.store.rememberStop(id, this.now() + TIMINGS.rememberedStopMs);
      return { result: "gone" };
    }
    if (b.state !== "stopping")
      this.store.updateBinding(id, {
        state: "stopping",
        stopReason: req.reason,
      });
    this.spawn(this.teardown(id, b.stopReason ?? req.reason));
    return { result: "accepted" };
  }

  /**
   * Remove route, clear policy, force-remove the container, release the slot, report (G10). The
   * order matters: an address is never free while a policy for it remains, and no route points
   * at a container that is going away. Resumable: each step is idempotent and the binding stays
   * (as `stopping`) until the last one, so a crash anywhere is finished by boot recovery.
   */
  private teardown(id: string, reason: EndReason): Promise<void> {
    const running = this.teardowns.get(id);
    if (running) return running;
    const p = this.doTeardown(id, reason).finally(() =>
      this.teardowns.delete(id),
    );
    this.teardowns.set(id, p);
    return p;
  }

  private async doTeardown(id: string, reason: EndReason): Promise<void> {
    const b = this.store.getBinding(id);
    if (!b) return;
    if (b.state !== "stopping")
      this.store.updateBinding(id, { state: "stopping", stopReason: reason });
    this.d.hub.removeRoute(id);
    await this.d.failpoints.hit("node.stop.after_route_removed");
    const recorded = this.store.getRecording(id);
    // W3. Let the recorder finish its last fragment; best effort, the file is playable without it.
    if (recorded && b.address && b.controlToken)
      await this.d.runtime
        .stopRecording(b.address, b.controlToken)
        .catch(() => undefined);
    if (b.address) await this.clearPolicyBeforeRemoval(id, b.address);
    // Nothing needs the proxy's password once its policy is gone (T-45).
    const up = b.policy.upstream;
    if (up?.password !== undefined)
      this.store.updateBinding(id, {
        policy: {
          ...b.policy,
          upstream: {
            host: up.host,
            port: up.port,
            ...(up.username !== undefined ? { username: up.username } : {}),
          },
        },
      });
    await this.d.failpoints.hit("node.stop.after_policy_cleared");
    // Known from creation, or from the container's label after a restart (reconcile); a volume
    // missed here (a teardown during boot) is an orphan that volume reaping removes.
    const volume =
      b.containerId && !recorded ? this.volumeOf.get(b.containerId) : undefined;
    if (b.containerId) this.volumeOf.delete(b.containerId);
    if (b.containerId && !(await this.deferRemoval(b.containerId, volume))) {
      await this.d.docker.remove(b.containerId);
      // A volume nobody recorded to goes with its container; reconciliation catches any left behind.
      if (volume) await this.d.volumes?.remove(volume).catch(() => undefined);
    }
    await this.d.failpoints.hit("node.stop.after_container_removed");

    const seconds = b.readyAt
      ? Math.max(0, (this.now() - b.readyAt) / 1000)
      : 0;
    // The binding goes and the report is queued in one transaction: a crash cannot lose the report.
    queueMicrotask(() => {
      void this.refillPool(); // a slot is free again
      // and the API should know it now, not at the next heartbeat
      if (this.c.reportOnRemoval ?? true) void this.flushSoon();
    });
    this.store.finishBinding(id, (rid) => ({
      id: rid,
      at: new Date(this.now()).toISOString(),
      kind: "removed",
      sessionId: id as never,
      endReason: reason,
      browserSeconds: seconds,
    }));
    this.gatewayAttachmentsDrop(id);
  }

  /** A session's egress policy. Start and resync both use this, so neither can drop the proxy (T-47). */
  private egressPolicyFor(
    sessionId: string,
    network: StartNetwork,
  ): EgressPolicy {
    return {
      sessionId: sessionId as never,
      ...(network.allow ? { allow: network.allow } : {}),
      ...(network.deny ? { deny: network.deny } : {}),
      connectionCap: LIMITS.egressConnectionCapPerSession,
      ...(network.upstream ? { upstream: network.upstream } : {}),
    };
  }

  /**
   * Push a session's policy. A gateway that does not confirm the session's proxy (one from
   * before upstream proxies answers with no acknowledgement) would send its traffic out
   * directly, so the policy is cleared again and the session is not used (T-47).
   */
  private async applyPolicy(
    address: string,
    sessionId: string,
    network: StartNetwork,
  ): Promise<void> {
    const ack = await this.d.egress.setPolicy(
      address,
      this.egressPolicyFor(sessionId, network),
    );
    if (network.upstream && ack?.upstream !== true) {
      await this.d.egress.clearPolicy(address).catch(() => undefined);
      throw new EgressUnsupported(
        "the egress gateway did not confirm the session's proxy",
      );
    }
  }

  /**
   * An address is never free while a policy for it remains (G10), so the policy is cleared before
   * the container goes, and a failed clear is retried. The one case it may be skipped is an egress
   * gateway that cannot be reached at all: it then holds no policies and refuses everything (N13),
   * so removing the container is still safe. If it is up but will not clear, the teardown fails and
   * is retried, with the container left in place.
   */
  private async clearPolicyBeforeRemoval(
    id: string,
    address: string,
  ): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.d.egress.clearPolicy(address);
        return;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
    const reachable = await this.d.egress.health().then(
      () => true,
      () => false,
    );
    this.d.log.warn(
      {
        session: id,
        reachable,
        err: last instanceof Error ? last.message : String(last),
      },
      "could not clear the egress policy",
    );
    if (reachable)
      throw last instanceof Error
        ? last
        : new Error("could not clear the egress policy");
  }

  // --- deadlines (G11) and attachments (G12) --------------------------------------------------

  /** Enforce absolute deadlines on this agent's clock. The authority is outside the container. */
  tick(): void {
    const now = this.now();
    for (const b of this.store.allBindings()) {
      // A teardown that failed (Docker would not remove the container) is not forgotten: try again, at most every 5 s.
      if (
        b.state === "stopping" &&
        !this.teardowns.has(b.sessionId) &&
        !this.inflight.has(b.sessionId)
      ) {
        if ((this.retryAt.get(b.sessionId) ?? 0) <= now) {
          this.retryAt.set(b.sessionId, now + 5_000);
          this.spawn(
            this.teardown(b.sessionId, b.stopReason ?? "runtime_crash"),
          );
        }
        continue;
      }
      if (b.state !== "ready") continue;
      if (now >= b.maxAt) this.expire(b, "max_lifetime");
      else if (b.idleAt !== null && now >= b.idleAt)
        this.expire(b, "idle_timeout");
    }
  }

  private expire(b: Binding, reason: EndReason): void {
    this.store.updateBinding(b.sessionId, {
      state: "stopping",
      stopReason: reason,
    });
    this.spawn(this.teardown(b.sessionId, reason));
  }

  /** A gateway reported its attachments (on connecting, and as they change). */
  handleAttachments(gatewayId: string, attachments: Attachment[]): void {
    this.gatewayAttachments.set(
      gatewayId,
      new Map(attachments.map((a) => [a.sessionId as string, a.connections])),
    );
    this.applyAttachments();
  }

  /** A gateway's connection closed: its attachments are gone (G12). */
  handleGatewayGone(gatewayId: string): void {
    this.gatewayAttachments.delete(gatewayId);
    this.applyAttachments();
  }

  private gatewayAttachmentsDrop(id: string): void {
    for (const m of this.gatewayAttachments.values()) m.delete(id);
  }

  private attachmentTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const m of this.gatewayAttachments.values())
      for (const [id, n] of m) totals.set(id, (totals.get(id) ?? 0) + n);
    return totals;
  }

  private applyAttachments(): void {
    const totals = this.attachmentTotals();
    const now = this.now();
    for (const b of this.store.allBindings()) {
      if (b.state !== "ready") continue;
      const n = totals.get(b.sessionId) ?? 0;
      if (n === b.attached) continue;
      const patch: Partial<Binding> = {
        attached: n,
        idleAt: n > 0 ? null : now + b.idleTimeoutMs,
      };
      this.store.updateBinding(b.sessionId, patch);
      this.store.enqueueEvent((id) => ({
        id,
        at: new Date(now).toISOString(),
        kind: "event",
        sessionId: b.sessionId as never,
        event:
          n > b.attached
            ? { type: "session.attached", data: { connections: n } }
            : { type: "session.detached", data: { connections: n } },
      }));
      if (n === 0 && b.stopOnDisconnect)
        this.expire(
          this.store.getBinding(b.sessionId) as Binding,
          "client_disconnect",
        );
    }
  }

  // --- reconciliation (G13) -------------------------------------------------------------------

  /**
   * Compare the containers that exist with the store. A session whose container is gone is
   * reported (it crashed, or was OOM-killed); a container nothing refers to is removed; dead
   * pooled browsers are dropped. Runs every 5 s and on Docker `die` and `oom` events.
   */
  /**
   * A container died or was OOM-killed. Only one the agent still counts on (a live session's, or
   * a pooled browser) can change anything, so only those trigger a reconcile; the agent's own
   * removals, one per session under churn, used to trigger a full pass each, and every pass is a
   * listing plus inspects through a Docker daemon that serializes container work.
   */
  containerDied(id: string): void {
    const ours =
      this.store.allPool().some((p) => p.containerId === id) ||
      this.store
        .allBindings()
        .some((b) => b.containerId === id && b.state !== "stopping");
    if (ours) void this.reconcile().catch(() => undefined);
  }

  /** One pass at a time: a call during a pass runs one more pass after it, however many calls arrive. */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return this.reconciling;
    }
    const run = (async () => {
      try {
        do {
          this.reconcileAgain = false;
          await this.doReconcile();
        } while (this.reconcileAgain);
      } finally {
        this.reconciling = null;
      }
    })();
    this.reconciling = run;
    return run;
  }

  private async doReconcile(): Promise<void> {
    const containers = await this.d.docker.list();
    const present = new Set(containers.map((c) => c.id));
    for (const id of this.volumeOf.keys())
      if (!present.has(id)) this.volumeOf.delete(id);
    // After a restart the map is empty: the volume is also on the container's label.
    for (const c of containers)
      if (c.labels["kestrel.volume"] && !this.volumeOf.has(c.id))
        this.volumeOf.set(c.id, c.labels["kestrel.volume"]);
    const byId = new Map(containers.map((c) => [c.id, c]));
    const now = this.now();

    for (const b of this.store.allBindings()) {
      if (
        !b.containerId ||
        b.state === "stopping" ||
        this.inflight.has(b.sessionId)
      )
        continue;
      let c = byId.get(b.containerId);
      if (c?.running) continue;
      // The listing may be older than the container (or this binding): look again before judging it gone.
      c =
        (await this.d.docker.inspect(b.containerId).catch(() => null)) ??
        undefined;
      if (c?.running) continue;
      if (!this.store.getBinding(b.sessionId) || this.inflight.has(b.sessionId))
        continue;
      const reason: EndReason = c?.oomKilled ? "oom" : "browser_crash";
      this.d.log.warn(
        { session: b.sessionId, reason },
        "a session's container is gone",
      );
      this.store.enqueueReport((id) => ({
        id,
        at: new Date(now).toISOString(),
        kind: "event",
        sessionId: b.sessionId as never,
        event: {
          type: "runtime.crashed",
          data: {
            process: "container",
            exitCode: c?.exitCode ?? null,
            signal: null,
          },
        },
      }));
      this.expire(b, reason);
    }

    const known = new Set<string>();
    for (const b of this.store.allBindings())
      if (b.containerId) known.add(b.containerId);
    for (const q of this.reapQueue) known.add(q.id);
    for (const p of this.store.allPool()) {
      // The container list is a snapshot from the start of this pass: a pooled browser made since
      // then has a record but is not in it. Look again before treating it as gone, or its record
      // is dropped while it runs, and 15 s later it is removed as unknown (a warm browser lost).
      const c =
        byId.get(p.containerId) ??
        (await this.d.docker.inspect(p.containerId).catch(() => null));
      if (!c || !c.running) {
        this.d.log.info(
          {
            container: p.containerId.slice(0, 12),
            found: Boolean(c),
            running: c?.running ?? null,
            state: p.state,
          },
          "pool: reconciliation dropped a record",
        );
        this.store.deletePool(p.containerId);
        if (c) await this.d.docker.remove(c.id).catch(() => undefined);
      } else known.add(p.containerId);
    }
    for (const c of containers) {
      if (known.has(c.id) || now - c.createdAt < this.c.newContainerGraceMs)
        continue;
      // The listing is a snapshot: the reaper may have removed this one since (and taken it off
      // its queue, so it is no longer known). Only one that still exists is a real leftover.
      if (!(await this.d.docker.inspect(c.id).catch(() => null))) continue;
      this.d.log.warn(
        { container: c.id.slice(0, 12) },
        "removing a container nothing refers to",
      );
      await this.d.docker.remove(c.id).catch(() => undefined);
    }
    await this.reapVolumes(containers, now).catch((e) =>
      this.d.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not reap recording volumes",
      ),
    );
  }

  // --- recordings (W3) --------------------------------------------------------------------------

  private volumeWarned = false;

  /** A size-limited volume for a new container's recording, or none if this host cannot limit its size. */
  private async makeRecordingVolume(): Promise<string | undefined> {
    if (!this.d.volumes) return undefined;
    const name = `kestrel-rec-${this.c.nodeId}-${hex(8)}`;
    try {
      await this.d.volumes.create(name, RECORDING_LIMITS.volumeBytes);
      return name;
    } catch (e) {
      if (!this.volumeWarned) {
        this.volumeWarned = true;
        this.d.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "cannot make size-limited recording volumes; sessions on this node will not be recorded",
        );
      }
      return undefined;
    }
  }

  /**
   * Remove recording volumes no container uses and no kept recording names, and recordings past
   * retention. A volume younger than the new-container grace may belong to a container being made.
   */
  private async reapVolumes(
    containers: ContainerInfo[],
    now: number,
  ): Promise<void> {
    const v = this.d.volumes;
    if (!v) return;
    for (const r of this.store.allRecordings()) {
      if (now - r.createdAt < RECORDING_LIMITS.retentionMs) continue;
      if (this.store.getBinding(r.sessionId)) continue; // still running
      await v.remove(r.volume);
      this.store.deleteRecording(r.sessionId);
    }
    const used = new Set<string>();
    for (const c of containers)
      if (c.labels["kestrel.volume"]) used.add(c.labels["kestrel.volume"]);
    for (const r of this.store.allRecordings()) used.add(r.volume);
    for (const vol of await v.list()) {
      if (used.has(vol.name)) continue;
      if (now - vol.createdAt < this.c.newContainerGraceMs) continue;
      await v.remove(vol.name).catch(() => undefined);
    }
  }

  /**
   * W3. The session's recording file, opened safely: the volume was written by an untrusted
   * container, so the file must be a regular file reached without following a link, and no
   * larger than the recorder's limit (threat model: anything read back from a container is hostile).
   */
  async openRecording(
    sessionId: string,
  ): Promise<{ fd: FileHandle; size: number } | null> {
    const r = this.store.getRecording(sessionId);
    if (!r || !this.d.volumes) return null;
    const dir = await this.d.volumes.path(r.volume);
    if (!dir) return null;
    let fd: FileHandle;
    try {
      fd = await open(
        join(dir, RECORDING_FILE),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch {
      return null;
    }
    const st = await fd.stat();
    if (!st.isFile() || st.size > RECORDING_LIMITS.volumeBytes) {
      await fd.close();
      return null;
    }
    return { fd, size: st.size };
  }

  /**
   * Keep the egress gateway's policies equal to the ready sessions'. After the egress gateway
   * restarts it holds none and refuses everything (N13); this pushes them back and tells it
   * so. Also removes a policy no ready session owns, so an address is never left with a way out.
   */
  async syncEgress(): Promise<void> {
    // One at a time: two overlapping syncs, or a sync racing a teardown, could re-create a policy for an address that was just freed.
    while (this.syncing) await this.syncing.catch(() => undefined);
    const run = this.doSyncEgress().finally(() => {
      this.syncing = null;
    });
    this.syncing = run;
    return run;
  }

  private async doSyncEgress(): Promise<void> {
    const health = await this.d.egress.health();
    const have = new Map(
      (await this.d.egress.list()).policies.map((p) => [p.ip, p]),
    );
    const want = new Map<string, Binding>();
    for (const b of this.store.allBindings())
      if ((b.state === "ready" || b.state === "starting") && b.address)
        want.set(b.address, b);
    // A pooled browser must have no policy (R15).
    for (const [ip, p] of have) {
      const b = want.get(ip);
      if (!b || p.sessionId !== b.sessionId)
        await this.d.egress.clearPolicy(ip).catch(() => undefined);
    }
    for (const [ip, b] of want) {
      const p = have.get(ip);
      // The same session through the same proxy: nothing to do. A policy that lost its proxy
      // is pushed again, never left to send the session's traffic out directly.
      if (
        p &&
        p.sessionId === b.sessionId &&
        sameUpstream(p.upstream, b.policy.upstream)
      )
        continue;
      // The session may have started to end while this sync was running: do not give its address a policy back.
      const cur = this.store.getBinding(b.sessionId);
      if (!cur || cur.state === "stopping" || this.teardowns.has(b.sessionId))
        continue;
      try {
        await this.applyPolicy(ip, b.sessionId, b.policy);
      } catch (e) {
        if (!(e instanceof EgressUnsupported)) throw e;
        // Cleared again: the session has no way out until a gateway that chains proxies runs.
        this.d.log.error(
          { session: b.sessionId },
          "the egress gateway did not confirm the session's proxy",
        );
      }
    }
    if (!health.policiesRestored) await this.d.egress.restored();
  }

  // --- firewall (N3, G17) ---------------------------------------------------------------------

  async checkFirewall(): Promise<void> {
    let status = await this.d.firewall.verify();
    if (!status.ok) {
      this.d.log.warn(
        { problems: status.problems },
        "firewall rules are not as required; reinstalling",
      );
      await this.d.firewall
        .ensure()
        .catch((e) =>
          this.d.log.error(
            { err: String(e) },
            "could not install the firewall rules",
          ),
        );
      status = await this.d.firewall.verify();
    }
    // Until the chain is verified no container is created and no start is admitted.
    this.firewallOk = status.ok;
    if (!status.ok)
      this.d.log.error(
        { problems: status.problems },
        "FIREWALL NOT VERIFIED: refusing to start sessions",
      );
  }

  get admitting(): boolean {
    return this.firewallOk;
  }

  // --- talking to the API (K7, G15) -----------------------------------------------------------

  async heartbeat(): Promise<void> {
    let reply: HeartbeatResponse;
    try {
      reply = await this.d.api.heartbeat(this.describe());
    } catch (e) {
      // The data plane survives the control plane: sessions keep running, reports wait.
      this.d.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "heartbeat failed",
      );
      return;
    }
    // An epoch never goes back: a stale or odd reply must not make this node refuse the API's starts.
    if (reply.epoch > this.store.epoch) {
      this.d.log.info(
        { from: this.store.epoch, to: reply.epoch },
        "adopting a new epoch",
      );
      this.store.epoch = reply.epoch;
    }
    for (const s of reply.stop)
      await this.stop({ sessionId: s.sessionId, reason: s.reason });
    for (const s of reply.unknown)
      await this.stop({ sessionId: s, reason: "node_refused" });
  }

  /**
   * Send reports at once rather than with the next heartbeat (up to 2 s later). A session's slot
   * is counted as used until the API hears its container is gone, so under a steady stream of
   * short sessions every second of delay keeps slots out of use. Flushes never overlap: one asked
   * for during another runs once more after it.
   */
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  flushSoon(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        await this.flushReports().catch(() => undefined);
      } while (this.flushAgain);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async flushReports(): Promise<void> {
    // Drain a few batches per call, so a backlog does not take a heartbeat per hundred reports to clear.
    for (let batch = 0; batch < 5; batch++) {
      const reports = this.store.pendingReports(100);
      if (reports.length === 0) return;
      try {
        const res = await this.d.api.reports({
          nodeId: this.c.nodeId as ReportsRequest["nodeId"],
          epoch: this.store.epoch,
          reports,
        });
        this.store.ackReports(res.acked);
        if (res.acked.length === 0) return;
      } catch (e) {
        this.d.log.warn(
          {
            err: e instanceof Error ? e.message : String(e),
            pending: reports.length,
          },
          "could not send reports; they are kept",
        );
        return;
      }
    }
  }

  /** Turn the egress gateway's denials into events on the sessions' timelines (N14). */
  async pollDenials(): Promise<void> {
    let res = await this.d.egress.denials(this.denialCursor.seq);
    if (res.epoch !== this.denialCursor.epoch) {
      // The egress gateway restarted: its sequence numbers start again.
      this.denialCursor = { epoch: res.epoch, seq: 0 };
      res = await this.d.egress.denials(0);
    }
    const live = new Set(this.store.allBindings().map((b) => b.sessionId));
    for (const d of res.denials) {
      this.denialCursor.seq = Math.max(this.denialCursor.seq, d.seq);
      if (!live.has(d.sessionId)) continue;
      this.store.enqueueReport((id) => ({
        id,
        at: d.at,
        kind: "event",
        sessionId: d.sessionId,
        event: {
          type: "egress.denied",
          data: {
            host: d.host,
            port: d.port,
            reason: d.reason,
            count: d.count,
          },
        },
      }));
    }
  }

  // --- loops ----------------------------------------------------------------------------------

  startLoops(): void {
    const every = (
      ms: number,
      fn: () => Promise<void> | void,
      name: string,
    ): void => {
      let running = false;
      const t = setInterval(() => {
        // Skip a tick if the last one has not finished: a slow Docker or API must not pile up work.
        if (running) return;
        running = true;
        Promise.resolve()
          .then(fn)
          .catch((e) =>
            this.d.log.warn(
              { loop: name, err: e instanceof Error ? e.message : String(e) },
              "loop iteration failed",
            ),
          )
          .finally(() => {
            running = false;
          });
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(
      TIMINGS.heartbeatIntervalMs,
      async () => {
        // Reports first: a heartbeat that stops listing a session before its `removed` report has been
        // delivered makes the API think the session vanished, and it would record the wrong reason.
        await this.flushSoon();
        await this.heartbeat();
      },
      "heartbeat",
    );
    every(1000, () => this.tick(), "deadlines");
    every(2000, () => this.pollCaptchas(), "captcha");
    every(1000, () => this.refillPool(), "pool");
    every(250, () => this.reap(), "reap");
    every(
      TIMINGS.dockerReconcileIntervalMs,
      async () => {
        await this.reconcile();
        await this.syncEgress();
        await this.pollDenials();
      },
      "reconcile",
    );
    every(
      TIMINGS.firewallCheckIntervalMs,
      () => this.checkFirewall(),
      "firewall",
    );
  }

  // --- CAPTCHAs (docs/lld/captcha.md) ---------------------------------------------------------

  /** Browsers whose `runtimed` predates CAPTCHA detection (it answered 404): not asked again. */
  private captchaUnsupported = new Set<string>();
  /** Consecutive failures per session; after 3, asked only every 30 s. */
  private captchaFailures = new Map<string, { n: number; next: number }>();
  /** Per-session budget for state changes: a burst of 6, then one every 10 s (T-50). */
  private captchaBudget = new Map<string, { tokens: number; at: number }>();

  /**
   * Ask each ready session's browser which known CAPTCHAs are showing, and report what changed.
   * The answer is hostile input: bounded, validated, and only ever turned into provider names
   * and a page hostname.
   */
  async pollCaptchas(): Promise<void> {
    const ready = this.store
      .allBindings()
      .filter(
        (b) =>
          b.state === "ready" &&
          b.address &&
          b.controlToken &&
          b.containerId &&
          !this.captchaUnsupported.has(b.containerId),
      );
    const live = new Set(this.store.allBindings().map((b) => b.sessionId));
    for (const m of [this.captchaFailures, this.captchaBudget])
      for (const id of m.keys()) if (!live.has(id)) m.delete(id);
    for (let i = 0; i < ready.length; i += 16)
      await Promise.all(ready.slice(i, i + 16).map((b) => this.pollCaptcha(b)));
  }

  private async pollCaptcha(b: Binding): Promise<void> {
    const id = b.sessionId;
    const now = this.now();
    const failing = this.captchaFailures.get(id);
    if (failing && now < failing.next) return;
    let answer;
    try {
      answer = await this.d.runtime.captcha(
        b.address as string,
        b.controlToken as string,
        1000,
      );
    } catch {
      const n = (failing?.n ?? 0) + 1;
      this.captchaFailures.set(id, { n, next: n >= 3 ? now + 30_000 : 0 });
      return;
    }
    this.captchaFailures.delete(id);
    if (answer === null) {
      this.captchaUnsupported.add(b.containerId as string);
      return;
    }
    if (!answer.watching) return; // unknown: report nothing rather than a false "cleared"

    const hosts = new Map<CaptchaProvider, string | null>();
    for (const d of answer.detections)
      if (!hosts.has(d.provider)) hosts.set(d.provider, d.host);
    const next = captchaSet(hosts.keys());
    const prev = this.store.getCaptcha(id);
    if (next.join() === prev.join()) return;

    const budget = this.captchaBudget.get(id) ?? { tokens: 6, at: now };
    budget.tokens = Math.min(6, budget.tokens + (now - budget.at) / 10_000);
    budget.at = now;
    this.captchaBudget.set(id, budget);
    if (budget.tokens < 1) return; // coalesced: a later poll reports the state it finds then

    const at = new Date(now).toISOString();
    const events: ((rid: string) => Report)[] = [];
    // Each event says what is present after it, one change at a time.
    let present = prev;
    for (const provider of prev.filter((p) => !next.includes(p))) {
      present = present.filter((p) => p !== provider);
      const snapshot = present;
      events.push((rid) => ({
        id: rid,
        at,
        kind: "event",
        sessionId: id as never,
        event: {
          type: "captcha.cleared",
          data: { provider, present: snapshot },
        },
      }));
    }
    for (const provider of next.filter((p) => !prev.includes(p))) {
      present = captchaSet([...present, provider]);
      const snapshot = present;
      events.push((rid) => ({
        id: rid,
        at,
        kind: "event",
        sessionId: id as never,
        event: {
          type: "captcha.detected",
          data: {
            provider,
            host: hosts.get(provider) ?? null,
            present: snapshot,
          },
        },
      }));
    }
    if (!this.store.recordCaptcha(id, next, events)) return;
    budget.tokens -= 1;
    void this.flushSoon();
  }

  stopLoops(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

/** The egress gateway did not confirm a session's proxy: the session must not be used (T-47). */
class EgressUnsupported extends Error {}

/** Same proxy, compared as the gateway lists it (no password). */
function sameUpstream(
  listed: UpstreamProxyView | undefined,
  want: StartNetwork["upstream"],
): boolean {
  if (!listed || !want) return !listed && !want;
  return (
    listed.host === want.host &&
    listed.port === want.port &&
    listed.username === want.username
  );
}

class StartAborted extends Error {
  constructor() {
    super("start aborted: the session was stopped");
  }
}
