import { z } from "zod";
import {
  CaptchaClearedData,
  CaptchaDetectedData,
  CaptchaFailedData,
  CaptchaSolvedData,
  CaptchaSolvingData,
} from "./captcha.js";
import { EventId, NodeId, SessionId } from "./ids.js";
import { EndReason, SessionStatus, StartPath } from "./session.js";

/**
 * C8. Events explain a session's history (K12). Events about a session are written in the
 * same transaction as the state change they describe. Node-side events (attach, egress
 * denials, crashes) arrive through the node's reports (C4).
 */
const IsoTime = z.iso.datetime({ offset: true });

export const EGRESS_DENY_REASONS = [
  "blocked_address", // not ordinary public unicast, or IPv6, or the host's own address (N7)
  "port_not_allowed", // anything but 80 and 443 (N9)
  "not_in_allow_list",
  "in_deny_list",
  "resolve_failed",
  "connection_cap", // N11
  "no_policy", // N6, N13
  // Upstream proxies (docs/lld/upstream-proxy.md)
  "upstream_blocked", // the proxy's address is not public, is the host's own, or its port is a bad port
  "upstream_unreachable", // the proxy did not resolve, refused or timed out, or closed before replying
  "upstream_auth_failed", // the proxy refused the credentials: HTTP 407, or SOCKS5 authentication failed
  "upstream_refused", // any other non-2xx or SOCKS5 failure reply, or a malformed or oversized reply
  "upstream_tls_failed", // https:// proxy: the TLS handshake failed, or the certificate did not verify for the proxy's name
] as const;
export const EgressDenyReason = z.enum(EGRESS_DENY_REASONS);
export type EgressDenyReason = z.infer<typeof EgressDenyReason>;

/** The type and payload of an event, without its id, session or time. */
export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.requested"), data: z.object({}) }),
  z.object({
    type: z.literal("session.scheduled"),
    data: z.object({ nodeId: NodeId }),
  }),
  z.object({ type: z.literal("session.starting"), data: z.object({}) }),
  z.object({
    type: z.literal("session.ready"),
    data: z.object({ startPath: StartPath, readyMs: z.number().nonnegative() }),
  }),
  z.object({
    type: z.literal("session.attached"),
    data: z.object({ connections: z.number().int().positive() }),
  }),
  z.object({
    type: z.literal("session.detached"),
    data: z.object({ connections: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal("session.stopping"),
    data: z.object({ endReason: EndReason }),
  }),
  z.object({
    type: z.literal("session.ended"),
    data: z.object({ endReason: EndReason, status: SessionStatus }),
  }),
  z.object({
    type: z.literal("egress.denied"),
    data: z.object({
      host: z.string().max(253),
      port: z.number().int(),
      reason: EgressDenyReason,
      /** Denials are rate-limited and aggregated: how many this event stands for (N14). */
      count: z.number().int().positive(),
    }),
  }),
  z.object({
    type: z.literal("runtime.crashed"),
    data: z.object({
      process: z.enum(["chrome", "runtimed", "xvfb", "container"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal("node.lost"),
    data: z.object({ nodeId: NodeId }),
  }),
  /** A CAPTCHA from a known provider appeared in a page (docs/lld/captcha.md). */
  z.object({
    type: z.literal("captcha.detected"),
    data: CaptchaDetectedData,
  }),
  /** It went away: removed, navigated from, or its tab closed. Not necessarily solved. */
  z.object({
    type: z.literal("captcha.cleared"),
    data: CaptchaClearedData,
  }),
  /** Sessions with `captcha.solve`: the deployment's solver service was asked. */
  z.object({
    type: z.literal("captcha.solving"),
    data: CaptchaSolvingData,
  }),
  /** The token is in the page. The site may still refuse it. */
  z.object({
    type: z.literal("captcha.solved"),
    data: CaptchaSolvedData,
  }),
  /** No token was put in: hand the CAPTCHA to a person. */
  z.object({
    type: z.literal("captcha.failed"),
    data: CaptchaFailedData,
  }),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];

/** Event types a node may report, as opposed to ones only the API writes. */
export const NODE_REPORTABLE_EVENT_TYPES = [
  "session.attached",
  "session.detached",
  "egress.denied",
  "runtime.crashed",
  "captcha.detected",
  "captcha.cleared",
  "captcha.solving",
  "captcha.solved",
  "captcha.failed",
] as const satisfies readonly EventType[];

export const SessionEvent = z
  .intersection(
    z.object({ id: EventId, sessionId: SessionId, at: IsoTime }),
    EventBody,
  )
  .meta({ id: "SessionEvent" });
export type SessionEvent = z.infer<typeof SessionEvent>;

export const ListEventsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    cursor: z.string().max(200).optional(),
  })
  .meta({ id: "ListEventsQuery" });

export const ListEventsResponse = z
  .object({ data: z.array(SessionEvent), nextCursor: z.string().nullable() })
  .meta({ id: "ListEventsResponse" });
export type ListEventsResponse = z.infer<typeof ListEventsResponse>;
