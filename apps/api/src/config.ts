import { readFileSync } from "node:fs";
import {
  CaptchaSolverConfig,
  CaptchaSolverService,
  PROFILE_LIMITS,
  type PublicEndpoint,
  parsePublicUrl,
  securePublicEndpoint,
} from "@kestrel/contracts";
import { FsProfileStore } from "@kestrel/shared";
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
  /**
   * Where clients reach the deployment: `https://<host>`, or `http://<host>[:port]` in local mode
   * (no TLS, trusted networks only). When unset, `PUBLIC_HOSTNAME` names a TLS deployment.
   */
  PUBLIC_URL: unsetIfEmpty(z.string().optional()),
  /** The hostname clients connect to, e.g. `<ip>.sslip.io`, for a TLS deployment. */
  PUBLIC_HOSTNAME: unsetIfEmpty(z.string().min(1).optional()),
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
  /**
   * P18 (docs/lld/p18-profiles.md 4.5): the profile store, shared with the node agents, and the
   * master key file (32 random bytes, or their hex or base64), readable by the API only. Without
   * both, profile calls and sessions with a profile are refused.
   */
  PROFILE_STORE_DIR: unsetIfEmpty(z.string().optional()),
  PROFILE_MASTER_KEY_FILE: unsetIfEmpty(z.string().optional()),
  /** Bytes of files in one profile version (64 MiB by default, at most 256 MiB). */
  PROFILE_MAX_BYTES: unsetIfEmpty(
    z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(PROFILE_LIMITS.maxBytesCeiling)
      .default(PROFILE_LIMITS.maxBytes),
  ),
});
export type Env = z.infer<typeof Env>;

/** The deployment's public endpoint, from `PUBLIC_URL` or else `PUBLIC_HOSTNAME`. */
export function publicEndpointOf(
  env: Pick<Env, "PUBLIC_URL" | "PUBLIC_HOSTNAME">,
): PublicEndpoint {
  if (env.PUBLIC_URL) return parsePublicUrl(env.PUBLIC_URL);
  if (env.PUBLIC_HOSTNAME) return securePublicEndpoint(env.PUBLIC_HOSTNAME);
  throw new Error("set PUBLIC_URL (or PUBLIC_HOSTNAME for a TLS deployment)");
}

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

/** The master key from its file: exactly 32 bytes, as raw bytes, hex or base64. */
export function parseMasterKey(raw: Buffer): Buffer {
  if (raw.length === 32) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    const b = Buffer.from(text, "base64");
    if (b.length === 32) return b;
  }
  throw new Error("PROFILE_MASTER_KEY_FILE does not hold a 32-byte key");
}

/** Profiles, or undefined when the deployment has none. Half a configuration fails the start. */
export function loadProfiles(
  env: Pick<
    Env,
    "PROFILE_STORE_DIR" | "PROFILE_MASTER_KEY_FILE" | "PROFILE_MAX_BYTES"
  >,
  read: (path: string) => Buffer = (p) => readFileSync(p),
): { store: FsProfileStore; master: Buffer; maxBytes: number } | undefined {
  if (!env.PROFILE_STORE_DIR && !env.PROFILE_MASTER_KEY_FILE) return undefined;
  if (!env.PROFILE_STORE_DIR || !env.PROFILE_MASTER_KEY_FILE)
    throw new Error(
      "profiles need both PROFILE_STORE_DIR and PROFILE_MASTER_KEY_FILE",
    );
  return {
    store: new FsProfileStore(env.PROFILE_STORE_DIR),
    master: parseMasterKey(read(env.PROFILE_MASTER_KEY_FILE)),
    maxBytes: env.PROFILE_MAX_BYTES,
  };
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
