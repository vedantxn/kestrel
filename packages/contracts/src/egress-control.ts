import { z } from "zod";
import { EgressDenyReason } from "./events.js";
import { SessionId } from "./ids.js";
import { HostPattern } from "./host-pattern.js";
import { LIMITS } from "./timings.js";
import { UpstreamProxy, UpstreamProxyView } from "./proxy.js";

/**
 * C7 (drafted; the network plan finalises it). The egress gateway's control API: HTTP and
 * JSON on a Unix socket at `/run/kestrel/<node>/egress.sock`, called by the node agent only.
 *
 * Policy is keyed by the container's source address on the session network (N6). An address
 * with no policy is refused entirely. The egress gateway starts with no policies and refuses
 * everything until the agent restores them (N13): it fails closed.
 */
export const EGRESS_PATHS = {
  health: "/v1/health",
  policies: "/v1/policies", // GET list
  policy: (ip: string) => `/v1/policies/${ip}`, // PUT set, DELETE clear (both idempotent)
  denials: "/v1/denials", // GET ?after=<seq>
  /** POST: the agent has pushed every policy it holds; until then the gateway reports `policiesRestored: false`. */
  restored: "/v1/restored",
  /** GET: bytes relayed per session since this process started (threat model G-20). */
  usage: "/v1/usage",
} as const;

/**
 * Strict, so a field a gateway does not know is refused rather than dropped (T-47). With an
 * `upstream`, every connection leaves through that proxy and never directly; the gateway
 * does not resolve the destination, only the proxy's own host.
 */
export const EgressPolicy = z.strictObject({
  sessionId: SessionId,
  allow: z.array(HostPattern).max(100).optional(),
  deny: z.array(HostPattern).max(100).optional(),
  connectionCap: z
    .number()
    .int()
    .positive()
    .default(LIMITS.egressConnectionCapPerSession),
  upstream: UpstreamProxy.optional(),
});
export type EgressPolicy = z.infer<typeof EgressPolicy>;

/**
 * The answer to `PUT /v1/policies/{ip}`. A gateway from before upstream proxies answers 204
 * with no body, so an agent that sent an upstream and gets no `upstream: true` back must not
 * use the session (T-47).
 */
export const EgressPolicyAck = z.object({
  sessionId: SessionId,
  upstream: z.boolean(),
});
export type EgressPolicyAck = z.infer<typeof EgressPolicyAck>;

/** A listed policy: the upstream without its password. */
export const EgressPolicyEntry = z.object({
  sessionId: SessionId,
  allow: z.array(HostPattern).max(100).optional(),
  deny: z.array(HostPattern).max(100).optional(),
  connectionCap: z.number().int().positive(),
  upstream: UpstreamProxyView.optional(),
  ip: z.ipv4(),
  openConnections: z.number().int().nonnegative(),
});
export type EgressPolicyEntry = z.infer<typeof EgressPolicyEntry>;
export const ListPoliciesResponse = z.object({
  policies: z.array(EgressPolicyEntry),
});
export type ListPoliciesResponse = z.infer<typeof ListPoliciesResponse>;

export const EgressHealth = z.object({
  status: z.literal("ok"),
  /** False after a restart, until the agent has restored every policy. */
  policiesRestored: z.boolean(),
  policyCount: z.number().int().nonnegative(),
});
export type EgressHealth = z.infer<typeof EgressHealth>;

/**
 * Denials, aggregated per (session, host, port, reason) and rate-limited per window (N14).
 * The agent polls with the last `seq` it saw and turns them into `egress.denied` reports.
 * `seq` restarts from zero if the egress gateway restarts; `epoch` tells the agent it did.
 */
export const EgressDenial = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: SessionId,
  host: z.string().max(253),
  port: z.number().int(),
  reason: EgressDenyReason,
  count: z.number().int().positive(),
  at: z.iso.datetime({ offset: true }),
});
export const DenialsResponse = z.object({
  epoch: z.string(),
  denials: z.array(EgressDenial),
});
export type DenialsResponse = z.infer<typeof DenialsResponse>;

/**
 * Threat model G-20: bytes relayed for a session by this process, counted at the browser's side
 * of the gateway. `up` is what the browser sent, `down` what it received. Counts start at zero
 * when the process starts (a new `epoch`), so the agent adds them to what it already holds.
 */
const ByteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const EgressSessionBytes = z.object({
  sessionId: SessionId,
  up: ByteCount,
  down: ByteCount,
});
export type EgressSessionBytes = z.infer<typeof EgressSessionBytes>;

/** `GET /v1/usage`: one entry per session with a policy. */
export const EgressUsageResponse = z.object({
  epoch: z.string().max(64),
  sessions: z.array(EgressSessionBytes).max(10_000),
});
export type EgressUsageResponse = z.infer<typeof EgressUsageResponse>;

/**
 * The answer to `DELETE /v1/policies/{ip}` when a policy was cleared: its session's final
 * counts, which the gateway then forgets. 204 when there was no policy, and from a gateway
 * from before byte counters.
 */
export const EgressClearAck = EgressSessionBytes.extend({
  epoch: z.string().max(64),
});
export type EgressClearAck = z.infer<typeof EgressClearAck>;
