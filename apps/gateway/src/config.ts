import { z } from "zod";

export const Env = z.object({
  NODE_ID: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
  /** Distinguishes two gateways that overlap during a deploy. */
  GATEWAY_ID: z.string().min(1).max(64).default(`gw-${process.pid}`),
  LISTEN_HOST: z.string().default("0.0.0.0"),
  LISTEN_PORT: z.coerce.number().int().default(8443),
  /** What discovery rewrites addresses to. */
  PUBLIC_HOSTNAME: z.string().min(1),
  PUBLIC_PORT: z.coerce.number().int().optional(),
  /** Directory holding cert.pem and key.pem (a copy of Caddy's, maintained by the node agent). */
  TLS_DIR: z.string().optional(),
  /** Serve plain HTTP. Never in production. */
  TLS_OFF: z.enum(["1", "true"]).optional(),
  TOKEN_PUBLIC_KEY_FILE: z.string().min(1),
  /** The node agent's Unix socket (C6). */
  AGENT_SOCKET: z.string().optional(),
  /** A static routes file, for use before the agent exists. */
  ROUTES_FILE: z.string().optional(),
  METRICS_HOST: z.string().default("127.0.0.1"),
  METRICS_PORT: z.coerce.number().int().default(7201),
  /** Share the port with a replacement process (W4). Linux only. */
  REUSE_PORT: z.enum(["1", "true"]).optional(),
  /** The node's slot count: each session's share of the buffer budget is the budget divided by it (G-03). */
  SLOTS: z.coerce.number().int().positive().optional(),
  /** Overrides that share, in bytes. */
  SESSION_BUFFER_SHARE_BYTES: z.coerce.number().int().positive().optional(),
  DRAIN_SECONDS: z.coerce.number().int().min(0).default(300),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof Env>;
