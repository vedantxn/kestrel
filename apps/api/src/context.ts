import type { CaptchaSolverConfig } from "@kestrel/contracts";
import type { PrismaClient } from "@kestrel/db";
import type { Clock, Failpoints, Logger, TokenSigner } from "@kestrel/shared";
import type { NodeConfig } from "./config.js";
import type { NodeClient } from "./node-client.js";
import type { Metrics } from "./metrics.js";
import type { RateLimiter } from "./rate-limit.js";

/** Everything a service needs, passed explicitly so tests can substitute any of it. */
export interface Ctx {
  db: PrismaClient;
  clock: Clock;
  log: Logger;
  failpoints: Failpoints;
  signer: TokenSigner;
  nodeClient: NodeClient;
  nodes: Map<string, NodeConfig>;
  publicHostname: string;
  metrics: Metrics;
  rateLimiter: RateLimiter;
  /** The API's call to a node (K5). Injectable so tests need not wait 30 seconds. */
  nodeCallTimeoutMs: number;
  /** Mutable counters local to this process. */
  state: { waiters: number; waitersByProject: Map<string, number> };
  /** Milliseconds from a clock that never steps or runs backwards (the sweeper's grace is measured on it). */
  monotonic: () => number;
  /**
   * The deployment's CAPTCHA solver, key included, or undefined. Sent to a node only in the start
   * of a session created with `captcha.solve`; never stored or returned (T-54).
   */
  captchaSolver?: CaptchaSolverConfig | undefined;
}

export interface Auth {
  projectId: string;
  apiKeyId: string;
}
