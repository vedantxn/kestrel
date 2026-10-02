import { readFileSync } from "node:fs";
import { z } from "zod";

const NodeConfig = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
  /** Where the API reaches the node agent's protocol listener. */
  address: z.url(),
  /** The per-node secret (K6), or the path of a file holding it. */
  secret: z.string().min(16).optional(),
  secretFile: z.string().optional(),
  /** The gateway's public port for sessions on this node (4.12). */
  connectPort: z.number().int().min(1).max(65535),
});
export type NodeConfig = z.infer<typeof NodeConfig> & { secret: string };

export const Env = z.object({
  DATABASE_URL: z.string().min(1),
  API_PUBLIC_HOST: z.string().default("127.0.0.1"),
  API_PUBLIC_PORT: z.coerce.number().int().default(8080),
  API_INTERNAL_HOST: z.string().default("127.0.0.1"),
  API_INTERNAL_PORT: z.coerce.number().int().default(8081),
  /** The hostname clients connect to: `<ip>.sslip.io`. */
  PUBLIC_HOSTNAME: z.string().min(1),
  TOKEN_PRIVATE_KEY_FILE: z.string().min(1),
  /** JSON array of node configs. */
  KESTREL_NODES: z.string().min(2),
  KESTREL_FAILPOINTS: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof Env>;

export function loadNodes(json: string): NodeConfig[] {
  const raw = z.array(NodeConfig).min(1).parse(JSON.parse(json));
  return raw.map((n) => {
    const secret =
      n.secret ??
      (n.secretFile ? readFileSync(n.secretFile, "utf8").trim() : undefined);
    if (!secret || secret.length < 16)
      throw new Error(`node ${n.id}: no secret of at least 16 characters`);
    return { ...n, secret };
  });
}
