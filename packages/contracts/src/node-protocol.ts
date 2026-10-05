import { z } from "zod";
import { EventBody, NODE_REPORTABLE_EVENT_TYPES } from "./events.js";
import { NodeId, ProjectId, SessionId } from "./ids.js";
import { UpstreamProxy } from "./proxy.js";
import { EndReason, NetworkPolicy, Viewport } from "./session.js";

/**
 * C4. The node protocol between the API and each node agent. HTTP and JSON on localhost
 * in v1, authenticated by a per-node secret: `Authorization: Bearer <node secret>` (K6).
 *
 * Two directions:
 *  - API -> agent, the fast path (K5): `start`, `stop`, `describe`.
 *  - agent -> API, the repair path (K7, G15): `register`, `heartbeat`, `reports`.
 *
 * The fast path makes starts quick; heartbeat reconciliation makes the system converge
 * when any message is lost.
 */
export const NODE_PROTOCOL_VERSION = 1;

export const NODE_PATHS = {
  // served by the node agent
  start: "/v1/start",
  stop: "/v1/stop",
  describe: "/v1/describe",
  /** W4: `{ sessionId, action }`, answered with a ComputerResponse. */
  computer: "/v1/computer",
  /** W3: `GET /v1/recording/<session id>` streams the session's video. */
  recording: "/v1/recording",
  // served by the API's internal listener
  register: "/internal/nodes/register",
  heartbeat: "/internal/nodes/heartbeat",
  reports: "/internal/nodes/reports",
} as const;

// --- start / stop ----------------------------------------------------------------------

/**
 * The session's egress settings as the node needs them. The upstream proxy, password
 * included, travels inside `network` on purpose: a node from before upstream proxies parses
 * `network` with the strict `NetworkPolicy` and refuses the start, rather than dropping the
 * field and letting the session exit from the host's address (T-47).
 */
export const StartNetwork = NetworkPolicy.extend({
  upstream: UpstreamProxy.optional(),
});
export type StartNetwork = z.infer<typeof StartNetwork>;

/** Strict: a field this node does not know is refused, never silently dropped. */
export const StartRequest = z.strictObject({
  sessionId: SessionId,
  projectId: ProjectId,
  /** The node's epoch as the API knows it; the node refuses a start from a stale view. */
  epoch: z.number().int().nonnegative(),
  viewport: Viewport,
  network: StartNetwork,
  /** Lifetime limits as durations; the agent turns them into absolute deadlines on its own clock (G11). */
  timeoutMs: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive(),
  stopOnDisconnect: z.boolean(),
  /** W3. Record the display; a node that cannot record starts the session anyway. */
  recording: z.boolean().default(false),
});
export type StartRequest = z.infer<typeof StartRequest>;

export const StartResponse = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("ready"),
    startPath: z.enum(["hot", "cold"]),
    readyMs: z.number().nonnegative(),
    deviceScaleFactor: z.number().positive(),
  }),
  /** The node cannot or will not start it: stale epoch, stop already remembered (G14), no slot. */
  z.object({ result: z.literal("refused"), reason: z.string() }),
  z.object({ result: z.literal("failed"), reason: z.string() }),
]);
export type StartResponse = z.infer<typeof StartResponse>;

export const StopRequest = z.object({
  sessionId: SessionId,
  reason: EndReason,
});
export type StopRequest = z.infer<typeof StopRequest>;

/** `gone`: the agent has no such session. That counts as confirmation (G14). */
export const StopResponse = z.object({ result: z.enum(["accepted", "gone"]) });
export type StopResponse = z.infer<typeof StopResponse>;

// --- the node's state, in heartbeats and describe ---------------------------------------------

export const NodeSessionState = z.enum(["starting", "ready", "stopping"]);

export const NodeSessionSummary = z.object({
  sessionId: SessionId,
  state: NodeSessionState,
});

export const NodeState = z.object({
  nodeId: NodeId,
  /** The epoch this agent last learned from the API. */
  epoch: z.number().int().nonnegative(),
  protocolVersion: z.literal(NODE_PROTOCOL_VERSION),
  slots: z.object({
    total: z.number().int().nonnegative(),
    free: z.number().int().nonnegative(),
  }),
  /** Hot browsers ready now. Used only to order node choice, never for correctness (K4). */
  hotCount: z.number().int().nonnegative(),
  /** Every session the agent holds: the list the API reconciles against. */
  sessions: z.array(NodeSessionSummary),
  /** Reports waiting to be sent, so the API can see a backlog. */
  pendingReports: z.number().int().nonnegative(),
});
export type NodeState = z.infer<typeof NodeState>;

// --- register / heartbeat -----------------------------------------------------------------

export const RegisterRequest = z.object({
  nodeId: NodeId,
  /** Zero for a node the agent has never been registered with. */
  epoch: z.number().int().nonnegative(),
  slotsTotal: z.number().int().positive(),
  /** Where the API reaches this agent. */
  address: z.string(),
  runtimeVersion: z.string(),
});
export const RegisterResponse = z.object({
  epoch: z.number().int().positive(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const HeartbeatRequest = NodeState;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/**
 * The reply is the reconciliation (K7, K10):
 *  - `stop`: sessions the node holds that the API has ended or is ending; stop them.
 *  - `unknown`: sessions the node holds that the API has no record of; stop them too.
 *  - `epoch`: the epoch to use. Higher than the node's means it was declared lost; adopt it.
 *  - `fenced`: the node's capacity is withheld. It lifts when a heartbeat lists none of the
 *    sessions the API ended while it was away.
 */
export const HeartbeatResponse = z.object({
  epoch: z.number().int().positive(),
  fenced: z.boolean(),
  stop: z.array(z.object({ sessionId: SessionId, reason: EndReason })),
  unknown: z.array(SessionId),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// --- reports (G15) ------------------------------------------------------------------------

const ReportCommon = {
  id: z.string().min(1).max(64),
  at: z.iso.datetime({ offset: true }),
};

/** An event the node saw. Only the types in `NODE_REPORTABLE_EVENT_TYPES` are accepted. */
const NodeEventBody = EventBody.refine(
  (e) => (NODE_REPORTABLE_EVENT_TYPES as readonly string[]).includes(e.type),
  "not a node-reportable event type",
);

export const Report = z.union([
  z.object({
    ...ReportCommon,
    kind: z.literal("event"),
    sessionId: SessionId,
    event: NodeEventBody,
  }),
  /**
   * The container is gone and its slot released. Completes `stopping`, and for a session the
   * agent ended on its own (deadline, crash, OOM) names the reason so the API records it.
   */
  z.object({
    ...ReportCommon,
    kind: z.literal("removed"),
    sessionId: SessionId,
    endReason: EndReason.nullable(),
    browserSeconds: z.number().nonnegative(),
  }),
]);
export type Report = z.infer<typeof Report>;

export const ReportsRequest = z.object({
  nodeId: NodeId,
  epoch: z.number().int().nonnegative(),
  reports: z.array(Report).min(1).max(500),
});
/** Each report has an id so a repeated delivery is harmless; the agent deletes what is acked. */
export const ReportsResponse = z.object({ acked: z.array(z.string()) });
export type ReportsRequest = z.infer<typeof ReportsRequest>;
export type ReportsResponse = z.infer<typeof ReportsResponse>;
