/**
 * Timings and sizes that more than one component must agree on (v1 plan section 4.12).
 * A component that needs a number only it uses keeps it in its own configuration.
 */
export const TIMINGS = {
  /** Node agent heartbeat and reconciliation with the API. */
  heartbeatIntervalMs: 2_000,
  /** A node silent this long is declared lost... */
  nodeLostAfterMs: 15_000,
  /** ...but only after the sweeper has been running and connected to the database this long. */
  sweeperGraceMs: 15_000,
  sweeperIntervalMs: 5_000,
  /** A session that has not reached ready by now is ended `start_timeout`. */
  startTimeoutMs: 45_000,
  /** The API's call to a node agent. */
  nodeCallTimeoutMs: 30_000,
  dockerReconcileIntervalMs: 5_000,
  firewallCheckIntervalMs: 30_000,
  /** How long an agent remembers a stop for a session it had not seen (G14). */
  rememberedStopMs: 5 * 60_000,
  gatewayPingIntervalMs: 30_000,
  /** The API's retry period while a create waits for capacity (A11). */
  admissionRetryMs: 250,
  /** How long an idempotency key is kept (A12). */
  idempotencyKeyTtlMs: 24 * 60 * 60_000,
  /** A token outlives its session's deadline by this much (C8). */
  tokenGraceMs: 60_000,
} as const;

export const LIMITS = {
  defaultSessionTimeoutMs: 15 * 60_000,
  maxSessionTimeoutMs: 6 * 60 * 60_000,
  minSessionTimeoutMs: 1_000,
  defaultIdleTimeoutMs: 5 * 60_000,
  maxWaitForCapacityMs: 60_000,
  /** Concurrent live sessions per project (A10). */
  defaultProjectConcurrentSessions: 20,
  /** Session creations per minute per project (A14). */
  defaultCreatesPerMinute: 300,
  egressConnectionCapPerSession: 256,
  defaultViewport: { width: 1280, height: 720 },
} as const;
