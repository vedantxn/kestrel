import { randomBytes } from "node:crypto";
import {
  LIMITS,
  NODE_PROTOCOL_VERSION,
  RUNTIME_PORTS,
  TIMINGS,
  type Attachment,
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
}

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
        // A ready session survives an agent restart. Nobody is attached until the gateways say so,
        // so the idle clock restarts from now; a gateway's hello will stop it again.
        this.store.updateBinding(b.sessionId, {
          attached: 0,
          idleAt: now + b.idleTimeoutMs,
        });
      }
    }
    await this.idle();
    await this.reconcile();
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
        const got = await this.acquire();
        held = { containerId: got.containerId, address: got.address };
        this.store.updateBinding(id, {
          containerId: got.containerId,
          address: got.address,
          controlToken: got.token,
          startPath: got.path,
        });
        await this.d.failpoints.hit("node.start.after_acquire");
        if (this.aborted(id)) throw new StartAborted();

        // The policy exists before the browser is usable (G7).
        await this.d.egress.setPolicy(got.address, {
          sessionId: id as never,
          ...(req.network.allow ? { allow: req.network.allow } : {}),
          ...(req.network.deny ? { deny: req.network.deny } : {}),
          connectionCap: LIMITS.egressConnectionCapPerSession,
        });
        await this.d.failpoints.hit("node.start.after_policy");

        // Configuring the container is also its health check: a browser that cannot apply it never gets a route.
        const proof = hex(32);
        const cfg = await this.d.runtime.configure(got.address, got.token, {
          sessionProof: proof as never,
          viewport: req.viewport,
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
          // Stopped while starting: the stop's own teardown removes the container.
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
      }
    }
    this.store.deleteBinding(id);
    return { result: "failed", reason: lastError };
  }

  // --- containers and the pool (G5, G6) -------------------------------------------------------

  /**
   * An admitted start is never refused for lack of a pooled browser (G6): take a hot one; else
   * wait for one that is still starting; else make one. The last two are the cold path.
   */
  private async acquire(): Promise<{
    containerId: string;
    address: string;
    token: string;
    path: "hot" | "cold";
  }> {
    for (const p of this.store.allPool().filter((p) => p.state === "hot")) {
      this.store.deletePool(p.containerId);
      const info = await this.d.docker.inspect(p.containerId).catch(() => null);
      if (info?.running)
        return {
          containerId: p.containerId,
          address: p.address,
          token: p.controlToken,
          path: "hot",
        };
      await this.d.docker.remove(p.containerId).catch(() => undefined);
    }
    for (const p of this.store
      .allPool()
      .filter((p) => p.state === "starting")) {
      const wait = this.poolStarting.get(p.containerId);
      if (!wait) continue;
      if (await wait) {
        const again = this.store
          .allPool()
          .find((x) => x.containerId === p.containerId && x.state === "hot");
        if (again) {
          this.store.deletePool(again.containerId);
          return {
            containerId: again.containerId,
            address: again.address,
            token: again.controlToken,
            path: "cold",
          };
        }
      }
    }
    // Cold. Free a slot's worth of pool first if the pool is using the room: sessions have priority.
    const spare = this.c.slotsTotal - this.sessionCount();
    const pool = this.store.allPool();
    if (pool.length > Math.max(0, spare - 1)) {
      const victim = pool[pool.length - 1];
      if (victim) {
        this.store.deletePool(victim.containerId);
        await this.d.docker.remove(victim.containerId).catch(() => undefined);
      }
    }
    const created = await this.createContainer("session");
    if (
      !(await this.waitReady(created.info.address as string, created.token))
    ) {
      await this.d.docker.remove(created.info.id).catch(() => undefined);
      throw new Error("the browser did not become ready");
    }
    return {
      containerId: created.info.id,
      address: created.info.address as string,
      token: created.token,
      path: "cold",
    };
  }

  private async createContainer(
    role: Role,
  ): Promise<{ info: ContainerInfo; token: string }> {
    const token = hex(24);
    const info = await this.d.docker.run(
      buildContainerSpec(this.d.dockerSpec, role, token),
    );
    if (!info.address) {
      await this.d.docker.remove(info.id).catch(() => undefined);
      throw new Error("the container has no address on the session network");
    }
    return { info, token };
  }

  /** Poll the container until its browser answers; "hot" must mean truly ready (R5). */
  private async waitReady(address: string, token: string): Promise<boolean> {
    const until = this.now() + this.c.readyTimeoutMs;
    for (;;) {
      try {
        const h = await this.d.runtime.health(address, token);
        if (h.status === "ready" && h.chromeReady) return true;
        if (h.status === "failed") return false;
      } catch {
        /* not up yet */
      }
      if (this.now() > until) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Top the pool up from slots no session is using, a few at a time (G5). */
  async refillPool(): Promise<void> {
    if (!this.firewallOk || !this.booted) return;
    const have = this.store.allPool().length + this.spawning;
    const room = this.c.slotsTotal - this.sessionCount() - have;
    const want = Math.min(this.c.poolTarget - have, this.c.refillAtOnce, room);
    for (let i = 0; i < want; i++) {
      this.spawning++;
      this.spawn(this.spawnPooled());
    }
  }

  private async spawnPooled(): Promise<void> {
    let created: { info: ContainerInfo; token: string };
    try {
      created = await this.createContainer("pool");
    } catch (e) {
      this.spawning--;
      this.d.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not create a pooled browser",
      );
      return;
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
          this.store.deletePool(info.id);
          await this.d.docker.remove(info.id).catch(() => undefined);
        }
        return false;
      },
    );
    this.poolStarting.set(info.id, ready);
    await ready;
    this.poolStarting.delete(info.id);
  }

  // --- stop (G10, G14) ------------------------------------------------------------------------

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
    if (b.address) {
      await this.d.egress.clearPolicy(b.address).catch((e) => {
        // If the egress gateway is down it holds no policies and refuses everything, so removing the container is still safe.
        this.d.log.warn(
          { session: id, err: e instanceof Error ? e.message : String(e) },
          "could not clear the egress policy",
        );
      });
    }
    await this.d.failpoints.hit("node.stop.after_policy_cleared");
    if (b.containerId) await this.d.docker.remove(b.containerId);
    await this.d.failpoints.hit("node.stop.after_container_removed");

    const seconds = b.readyAt
      ? Math.max(0, (this.now() - b.readyAt) / 1000)
      : 0;
    this.store.deleteBinding(id);
    this.store.enqueueReport((rid) => ({
      id: rid,
      at: new Date(this.now()).toISOString(),
      kind: "removed",
      sessionId: id as never,
      endReason: reason,
      browserSeconds: seconds,
    }));
    this.gatewayAttachmentsDrop(id);
  }

  // --- deadlines (G11) and attachments (G12) --------------------------------------------------

  /** Enforce absolute deadlines on this agent's clock. The authority is outside the container. */
  tick(): void {
    const now = this.now();
    for (const b of this.store.allBindings()) {
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

  private applyAttachments(): void {
    const totals = new Map<string, number>();
    for (const m of this.gatewayAttachments.values())
      for (const [id, n] of m) totals.set(id, (totals.get(id) ?? 0) + n);
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
      this.store.enqueueReport((id) => ({
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
  async reconcile(): Promise<void> {
    const containers = await this.d.docker.list();
    const byId = new Map(containers.map((c) => [c.id, c]));
    const now = this.now();

    for (const b of this.store.allBindings()) {
      if (
        !b.containerId ||
        b.state === "stopping" ||
        this.inflight.has(b.sessionId)
      )
        continue;
      const c = byId.get(b.containerId);
      if (c?.running) continue;
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
    for (const p of this.store.allPool()) {
      const c = byId.get(p.containerId);
      if (!c || !c.running) {
        this.store.deletePool(p.containerId);
        if (c) await this.d.docker.remove(c.id).catch(() => undefined);
      } else known.add(p.containerId);
    }
    for (const c of containers) {
      if (known.has(c.id) || now - c.createdAt < this.c.newContainerGraceMs)
        continue;
      this.d.log.warn(
        { container: c.id.slice(0, 12) },
        "removing a container nothing refers to",
      );
      await this.d.docker.remove(c.id).catch(() => undefined);
    }
  }

  /**
   * Keep the egress gateway's policies equal to the ready sessions'. After the egress gateway
   * restarts it holds none and refuses everything (N13); this pushes them back and tells it
   * so. Also removes a policy no ready session owns, so an address is never left with a way out.
   */
  async syncEgress(): Promise<void> {
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
      if (p && p.sessionId === b.sessionId) continue;
      await this.d.egress.setPolicy(ip, {
        sessionId: b.sessionId as never,
        ...(b.policy.allow ? { allow: b.policy.allow } : {}),
        ...(b.policy.deny ? { deny: b.policy.deny } : {}),
        connectionCap: LIMITS.egressConnectionCapPerSession,
      });
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
    if (reply.epoch !== this.store.epoch) {
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

  async flushReports(): Promise<void> {
    const reports = this.store.pendingReports(100);
    if (reports.length === 0) return;
    try {
      const res = await this.d.api.reports({
        nodeId: this.c.nodeId as ReportsRequest["nodeId"],
        epoch: this.store.epoch,
        reports,
      });
      this.store.ackReports(res.acked);
    } catch (e) {
      this.d.log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          pending: reports.length,
        },
        "could not send reports; they are kept",
      );
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
      const t = setInterval(() => {
        Promise.resolve()
          .then(fn)
          .catch((e) =>
            this.d.log.warn(
              { loop: name, err: e instanceof Error ? e.message : String(e) },
              "loop iteration failed",
            ),
          );
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(
      TIMINGS.heartbeatIntervalMs,
      async () => {
        await this.heartbeat();
        await this.flushReports();
      },
      "heartbeat",
    );
    every(1000, () => this.tick(), "deadlines");
    every(1000, () => this.refillPool(), "pool");
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

  stopLoops(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

class StartAborted extends Error {
  constructor() {
    super("start aborted: the session was stopped");
  }
}
