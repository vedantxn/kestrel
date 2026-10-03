import {
  type ComputerRequest,
  NODE_PATHS,
  NodeId,
  type EndReason,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Report,
  type StartRequest,
  type StartResponse,
  type StopRequest,
  type StopResponse,
} from "@kestrel/contracts";
import type { FastifyInstance } from "fastify";
import {
  NodeCallError,
  type ComputerResult,
  type NodeClient,
} from "../node-client.js";

export type StartMode =
  | "hot"
  | "cold"
  | "refuse"
  | "fail"
  | "timeout"
  | "unreachable"
  | "hang"
  /** The container is created, but the answer never arrives in time: an orphan unless stopped. */
  | "late";

/**
 * The node agent's side of the protocol, in memory: it holds sessions, answers the API's start
 * and stop calls, queues reports, and exchanges heartbeats. The tests drive it the way a real
 * agent would behave, including misbehaving.
 */
export class FakeNode {
  held = new Map<string, "starting" | "ready" | "stopping">();
  reports: Report[] = [];
  startMode: StartMode = "hot";
  startCalls: StartRequest[] = [];
  stopCalls: StopRequest[] = [];
  /** G14: a stop for a session not yet seen is remembered, and a later start is refused. */
  rememberedStops = new Set<string>();
  hotCount = 1;
  private reportSeq = 0;
  private release: (() => void) | undefined;

  constructor(
    readonly id: string,
    readonly secret: string,
    public slotsTotal: number,
    public epoch = 1,
    private readonly now: () => Date = () => new Date(),
  ) {}

  nodeId() {
    return NodeId.parse(this.id);
  }

  // --- API -> node ---------------------------------------------------------------------

  async start(req: StartRequest): Promise<StartResponse> {
    this.startCalls.push(req);
    if (this.rememberedStops.has(req.sessionId))
      return { result: "refused", reason: "stop already received" };
    switch (this.startMode) {
      case "refuse":
        return { result: "refused", reason: "no slot" };
      case "fail":
        return { result: "failed", reason: "chrome did not start" };
      case "timeout":
        throw new NodeCallError("timed out", "timeout");
      case "unreachable":
        throw new NodeCallError("unreachable", "unreachable");
      case "late":
        this.held.set(req.sessionId, "ready");
        throw new NodeCallError("timed out", "timeout");
      case "hang":
        // The binding exists while the browser is still starting, as in the real agent (G7).
        this.held.set(req.sessionId, "starting");
        await new Promise<void>((r) => (this.release = r));
        if (!this.held.has(req.sessionId))
          return { result: "failed", reason: "stopped while starting" };
        break;
    }
    this.held.set(req.sessionId, "ready");
    return {
      result: "ready",
      startPath: this.startMode === "cold" ? "cold" : "hot",
      readyMs: 12,
      deviceScaleFactor: 1,
    };
  }

  /** Let a `hang` start finish. */
  unhang(): void {
    this.release?.();
  }

  async stop(req: StopRequest): Promise<StopResponse> {
    this.stopCalls.push(req);
    if (!this.held.has(req.sessionId)) {
      this.rememberedStops.add(req.sessionId);
      return { result: "gone" };
    }
    this.teardown(req.sessionId, req.reason);
    return { result: "accepted" };
  }

  // --- the node's own life ---------------------------------------------------------------

  /** The container is gone: release the slot and queue the confirmation. */
  teardown(
    sessionId: string,
    reason: EndReason | null,
    browserSeconds = 5,
  ): void {
    this.held.delete(sessionId);
    this.reports.push({
      id: `r${++this.reportSeq}`,
      at: this.now().toISOString(),
      kind: "removed",
      sessionId: sessionId as never,
      endReason: reason,
      browserSeconds,
    });
  }

  /** The node ends a session on its own (deadline, crash): same as a teardown with a reason. */
  expire(sessionId: string, reason: EndReason): void {
    this.teardown(sessionId, reason);
  }

  report(
    sessionId: string,
    event: Extract<Report, { kind: "event" }>["event"],
  ): Report {
    const r: Report = {
      id: `r${++this.reportSeq}`,
      at: this.now().toISOString(),
      kind: "event",
      sessionId: sessionId as never,
      event,
    };
    this.reports.push(r);
    return r;
  }

  heartbeatBody(): HeartbeatRequest {
    return {
      nodeId: this.nodeId(),
      epoch: this.epoch,
      protocolVersion: 1,
      slots: {
        total: this.slotsTotal,
        free: Math.max(0, this.slotsTotal - this.held.size),
      },
      hotCount: this.hotCount,
      sessions: [...this.held].map(([sessionId, state]) => ({
        sessionId: sessionId as never,
        state,
      })),
      pendingReports: this.reports.length,
    };
  }

  // --- node -> API ---------------------------------------------------------------------

  private post(
    internal: FastifyInstance,
    url: string,
    payload: unknown,
    secret = this.secret,
  ) {
    return internal.inject({
      method: "POST",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  async register(internal: FastifyInstance): Promise<number> {
    const res = await this.post(internal, NODE_PATHS.register, {
      nodeId: this.id,
      epoch: this.epoch,
      slotsTotal: this.slotsTotal,
      address: `http://127.0.0.1:7${this.id.charCodeAt(0)}`,
      runtimeVersion: "test",
    });
    if (res.statusCode !== 200) throw new Error(`register failed: ${res.body}`);
    this.epoch = res.json().epoch;
    return this.epoch;
  }

  /** Send a heartbeat and do what the reply says, as the real agent would. */
  async heartbeat(internal: FastifyInstance): Promise<HeartbeatResponse> {
    const res = await this.post(
      internal,
      NODE_PATHS.heartbeat,
      this.heartbeatBody(),
    );
    if (res.statusCode !== 200)
      throw new Error(`heartbeat failed: ${res.statusCode} ${res.body}`);
    const reply = res.json() as HeartbeatResponse;
    this.epoch = reply.epoch;
    for (const s of reply.stop) {
      if (this.held.has(s.sessionId)) this.teardown(s.sessionId, s.reason);
    }
    for (const s of reply.unknown) {
      if (this.held.has(s)) this.teardown(s, "node_refused");
    }
    return reply;
  }

  async flushReports(internal: FastifyInstance): Promise<void> {
    if (this.reports.length === 0) return;
    const res = await this.post(internal, NODE_PATHS.reports, {
      nodeId: this.id,
      epoch: this.epoch,
      reports: this.reports,
    });
    if (res.statusCode !== 200)
      throw new Error(`reports failed: ${res.statusCode} ${res.body}`);
    const acked = new Set((res.json() as { acked: string[] }).acked);
    this.reports = this.reports.filter((r) => !acked.has(r.id));
  }

  /** A full exchange: reports, then a heartbeat, then reports produced by acting on its reply. */
  async sync(internal: FastifyInstance): Promise<HeartbeatResponse> {
    await this.flushReports(internal);
    const reply = await this.heartbeat(internal);
    await this.flushReports(internal);
    return reply;
  }
}

export class FakeNodeClient implements NodeClient {
  constructor(public nodes: Map<string, FakeNode>) {}

  start(nodeId: string, req: StartRequest): Promise<StartResponse> {
    return this.get(nodeId).start(req);
  }
  stop(nodeId: string, req: StopRequest): Promise<StopResponse> {
    return this.get(nodeId).stop(req);
  }
  /** Every action succeeds on a 1280x720 blank page; tests check the API around it. */
  async computer(
    nodeId: string,
    _sessionId: string,
    action: ComputerRequest,
  ): Promise<ComputerResult> {
    this.get(nodeId);
    this.computerCalls.push(action);
    const shot =
      action.action === "screenshot" ||
      ("screenshot" in action && action.screenshot);
    return {
      ok: true,
      response: {
        ok: true,
        width: 1280,
        height: 720,
        url: "about:blank",
        ...(shot ? { screenshot: "iVBORw0KGgo=" } : {}),
      },
    };
  }
  computerCalls: ComputerRequest[] = [];
  /** Recordings by session id, as bytes. */
  recordings = new Map<string, Uint8Array>();
  async recording(_nodeId: string, sessionId: string) {
    const b = this.recordings.get(sessionId);
    if (!b) return null;
    return {
      body: new Blob([b]).stream() as ReadableStream<Uint8Array>,
      size: b.length,
    };
  }
  private get(id: string): FakeNode {
    const n = this.nodes.get(id);
    if (!n) throw new NodeCallError(`unknown node ${id}`, "unreachable");
    return n;
  }
}
