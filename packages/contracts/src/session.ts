import { z } from "zod";
import { LIMITS } from "./timings.js";
import { HostPattern } from "./host-pattern.js";
import { NodeId, SessionId } from "./ids.js";

// --- Status and end reason (HLD 8.1) ---------------------------------------------------

export const SESSION_STATUSES = [
  "requested",
  "scheduling",
  "starting",
  "ready",
  "active",
  "stopping",
  "stopped",
  "failed",
  "timed_out",
] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const TERMINAL_STATUSES = [
  "stopped",
  "failed",
  "timed_out",
] as const satisfies readonly SessionStatus[];

export const END_REASONS = [
  "client_stop",
  "client_disconnect", // v1 addition: stopOnDisconnect fired. Ends `stopped`.
  "idle_timeout",
  "max_lifetime",
  "browser_crash",
  "oom",
  "runtime_crash",
  "node_lost",
  "start_timeout",
  "disk_limit",
  "node_refused",
] as const;
export const EndReason = z.enum(END_REASONS);
export type EndReason = z.infer<typeof EndReason>;

export function isTerminal(status: SessionStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The terminal status a session reaches after `stopping`, chosen by why it ended. */
export function terminalStatusFor(
  reason: EndReason,
): "stopped" | "failed" | "timed_out" {
  switch (reason) {
    case "client_stop":
    case "client_disconnect":
      return "stopped";
    case "idle_timeout":
    case "max_lifetime":
      return "timed_out";
    default:
      return "failed";
  }
}

/**
 * Every legal status change. A transition is applied as "set to X only if currently Y"
 * (K11), so two actors can never both win. Every non-terminal status may move to
 * `stopping`; a terminal status is written once, when the node confirms removal or the
 * sweeper declares the node lost.
 */
export const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  requested: ["scheduling", "stopping"],
  scheduling: ["starting", "stopping"],
  starting: ["ready", "stopping"],
  ready: ["active", "stopping"],
  active: ["ready", "stopping"],
  stopping: ["stopped", "failed", "timed_out"],
  stopped: [],
  failed: [],
  timed_out: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// --- Options (A3, A4, A5) ----------------------------------------------------------------

/** Chrome's own window is taller than the page by its toolbar; WP2 measures the exact limit. */
export const VIEWPORT_LIMITS = {
  minWidth: 200,
  maxWidth: 1920,
  minHeight: 200,
  maxHeight: 1000,
} as const;

export const Viewport = z
  .strictObject({
    width: z
      .number()
      .int()
      .min(VIEWPORT_LIMITS.minWidth)
      .max(VIEWPORT_LIMITS.maxWidth),
    height: z
      .number()
      .int()
      .min(VIEWPORT_LIMITS.minHeight)
      .max(VIEWPORT_LIMITS.maxHeight),
  })
  .meta({
    id: "Viewport",
    description: "The page's inner size in CSS pixels.",
  });
export type Viewport = z.infer<typeof Viewport>;

export const NetworkPolicy = z
  .strictObject({
    allow: z
      .array(HostPattern)
      .max(100)
      .optional()
      .describe("If present, only these hostnames may be reached."),
    deny: z
      .array(HostPattern)
      .max(100)
      .optional()
      .describe("These hostnames are refused."),
  })
  .meta({ id: "NetworkPolicy" });
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const Metadata = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .refine((m) => Object.keys(m).length <= 16, "at most 16 keys")
  .meta({ id: "Metadata" });

/**
 * What a caller may ask for. Strict: an unknown option is `invalid_request` naming it,
 * never silently ignored (A4). All durations are milliseconds.
 */
export const SessionOptions = z
  .strictObject({
    timeout: z
      .number()
      .int()
      .min(LIMITS.minSessionTimeoutMs)
      .max(LIMITS.maxSessionTimeoutMs)
      .default(LIMITS.defaultSessionTimeoutMs)
      .describe("Maximum lifetime in milliseconds."),
    idleTimeout: z
      .number()
      .int()
      .min(LIMITS.minSessionTimeoutMs)
      .max(LIMITS.maxSessionTimeoutMs)
      .default(LIMITS.defaultIdleTimeoutMs)
      .describe(
        "End the session after this long with no client attached, in milliseconds.",
      ),
    stopOnDisconnect: z
      .boolean()
      .default(false)
      .describe("End the session when its last client disconnects."),
    viewport: Viewport.default(LIMITS.defaultViewport),
    network: NetworkPolicy.default({}),
    metadata: Metadata.default({}),
  })
  .meta({ id: "SessionOptions" });
export type SessionOptions = z.infer<typeof SessionOptions>;

// --- Create request (A3, A11, A12) --------------------------------------------------------

export const CreateSessionRequest = SessionOptions.partial()
  .extend({
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Repeating a request with the same key returns the original session.",
      ),
    waitForCapacityMs: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.maxWaitForCapacityMs)
      .optional()
      .describe(
        "If the platform is full, retry admission for up to this long before answering 503.",
      ),
  })
  .meta({ id: "CreateSessionRequest" });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

// --- The session object (A7) --------------------------------------------------------------

export const StartPath = z.enum(["hot", "cold"]);
export type StartPath = z.infer<typeof StartPath>;

const IsoTime = z.iso.datetime({ offset: true });

export const Session = z
  .object({
    id: SessionId,
    status: SessionStatus,
    endReason: EndReason.nullable(),
    createdAt: IsoTime,
    readyAt: IsoTime.nullable(),
    endedAt: IsoTime.nullable(),
    connectUrl: z
      .string()
      .nullable()
      .describe(
        "A wss:// URL for Playwright, Puppeteer or any CDP client. Null unless the session can be connected to.",
      ),
    viewport: Viewport,
    deviceScaleFactor: z.number().positive(),
    options: SessionOptions,
    nodeId: NodeId.nullable(),
    startPath: StartPath.nullable(),
    usage: z.object({ browserSeconds: z.number().nonnegative() }),
  })
  .meta({ id: "Session" });
export type Session = z.infer<typeof Session>;

// --- Lists --------------------------------------------------------------------------------

export const ListSessionsQuery = z
  .object({
    status: SessionStatus.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .meta({ id: "ListSessionsQuery" });
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

export const ListSessionsResponse = z
  .object({ data: z.array(Session), nextCursor: z.string().nullable() })
  .meta({ id: "ListSessionsResponse" });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;
