import { z } from "zod";
import { SessionProof } from "./tokens.js";
import { Viewport } from "./session.js";

/**
 * C5 (drafted; the browser-runtime plan finalises it). The control API `runtimed` serves
 * inside each container on port 9000, called only by the node agent, authenticated by a
 * per-container bearer token the agent chose when it created the container.
 *
 * Everything in the container is untrusted (principle 2): the agent treats every response
 * as hostile input and validates it against these schemas.
 *
 * Ports inside the container:
 *   9222  Chrome's debugging port, localhost only
 *   9223  CDP forward: requires `x-kestrel-session-proof`, then passes bytes through untouched
 *   9000  this control API
 */
export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_PORTS = {
  chrome: 9222,
  cdpForward: 9223,
  control: 9000,
} as const;

export const RUNTIME_PATHS = {
  health: "/health",
  configure: "/configure",
} as const;

/** `GET /health`. A pooled container is "hot" only when this says `ready`. */
export const RuntimeHealth = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  status: z.enum(["starting", "ready", "failed"]),
  /** Chrome's debugging port answered. */
  chromeReady: z.boolean(),
  chromeVersion: z.string().nullable(),
});
export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

/**
 * `POST /configure`: bind a pooled browser to a session. Idempotent for the same proof, and
 * refused with 409 if the container was already configured with a different one. Doubles as
 * the health check that gates a start (G7): a browser that cannot apply it never gets a route.
 */
export const ConfigureRequest = z.object({
  sessionProof: SessionProof,
  viewport: Viewport,
});
export type ConfigureRequest = z.infer<typeof ConfigureRequest>;

export const ConfigureResponse = z.object({
  /** What the page actually measures, so the agent can verify the viewport took effect (A6). */
  viewport: Viewport,
  deviceScaleFactor: z.number().positive(),
  chromeVersion: z.string(),
});
export type ConfigureResponse = z.infer<typeof ConfigureResponse>;

/**
 * The module interface (drafted). `runtimed` has a small core (launch and supervise Chrome and
 * the display, forward CDP, report health) and modules owned by later plans (live view,
 * recording, downloads, profiles, stealth). A module may add routes to the control API and
 * hooks around Chrome's launch; it must not change the core's behaviour.
 */
export interface RuntimeModule {
  readonly name: string;
  /** Extra command-line flags for Chrome. */
  chromeArgs?(): string[];
  /** Called after Chrome's debugging port answers and before the container reports ready. */
  onChromeReady?(ctx: { cdpPort: number }): Promise<void>;
  /** Called when the session is configured. */
  onConfigure?(req: ConfigureRequest): Promise<void>;
  stop?(): Promise<void>;
}
