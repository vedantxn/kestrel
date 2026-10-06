import { readFileSync } from "node:fs";
import { CaptchaSolverConfig, CaptchaSolverService } from "@kestrel/contracts";
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

/** Compose passes an unset variable as an empty string. */
const unsetIfEmpty = <T extends z.ZodType>(t: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), t);

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
  /**
   * The deployment's CAPTCHA solver service (docs/lld/captcha.md), for sessions created with
   * `captcha.solve`. Without it, such sessions are refused. The key is read from a file, never
   * from the environment, so it is not in the compose file or `docker inspect`.
   */
  CAPTCHA_SOLVER: unsetIfEmpty(CaptchaSolverService.optional()),
  CAPTCHA_SOLVER_KEY_FILE: unsetIfEmpty(z.string().optional()),
  /** The service's API base: the operator's override (required for `custom`). */
  CAPTCHA_SOLVER_URL: unsetIfEmpty(z.string().optional()),
});
export type Env = z.infer<typeof Env>;

/**
 * The solver from the environment, or undefined when none is configured. A misconfiguration fails
 * the start, naming the variable and never the key.
 */
export function loadSolver(
  env: Pick<
    Env,
    "CAPTCHA_SOLVER" | "CAPTCHA_SOLVER_KEY_FILE" | "CAPTCHA_SOLVER_URL"
  >,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): CaptchaSolverConfig | undefined {
  if (!env.CAPTCHA_SOLVER) return undefined;
  if (!env.CAPTCHA_SOLVER_KEY_FILE)
    throw new Error("CAPTCHA_SOLVER is set but CAPTCHA_SOLVER_KEY_FILE is not");
  const parsed = CaptchaSolverConfig.safeParse({
    service: env.CAPTCHA_SOLVER,
    apiKey: read(env.CAPTCHA_SOLVER_KEY_FILE).trim(),
    ...(env.CAPTCHA_SOLVER_URL ? { url: env.CAPTCHA_SOLVER_URL } : {}),
  });
  if (!parsed.success)
    throw new Error(
      `invalid CAPTCHA solver configuration: ${parsed.error.issues
        .map((i) => i.path.join(".") || "(config)")
        .join(", ")}`,
    );
  return parsed.data;
}

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
