import { z } from "zod";
import { EgressDenyReason } from "./events.js";
import { SessionId } from "./ids.js";
import { HostPattern } from "./host-pattern.js";
import { LIMITS } from "./timings.js";

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
} as const;

export const EgressPolicy = z.object({
  sessionId: SessionId,
  allow: z.array(HostPattern).max(100).optional(),
  deny: z.array(HostPattern).max(100).optional(),
  connectionCap: z
    .number()
    .int()
    .positive()
    .default(LIMITS.egressConnectionCapPerSession),
});
export type EgressPolicy = z.infer<typeof EgressPolicy>;

export const EgressPolicyEntry = EgressPolicy.extend({
  ip: z.ipv4(),
  openConnections: z.number().int().nonnegative(),
});
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
