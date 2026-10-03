import { readFileSync, readFileSync as readSecretFile } from "node:fs";

// Secrets are files, not environment variables (threat model G-09): DATABASE_URL_FILE names the file holding the URL.
if (!process.env.DATABASE_URL && process.env.DATABASE_URL_FILE)
  process.env.DATABASE_URL = readSecretFile(
    process.env.DATABASE_URL_FILE,
    "utf8",
  ).trim();
import { createPrisma } from "@kestrel/db";
import {
  Failpoints,
  TokenSigner,
  createLogger,
  parseEnv,
  systemClock,
} from "@kestrel/shared";
import { Env, loadNodes } from "./config.js";
import type { Ctx } from "./context.js";
import { buildInternalApp, buildPublicApp } from "./http.js";
import { createMetrics } from "./metrics.js";
import { HttpNodeClient } from "./node-client.js";
import { RateLimiter } from "./rate-limit.js";
import { Sweeper } from "./sweeper.js";

const env = parseEnv(Env);
const log = createLogger("api", env.LOG_LEVEL);
const nodes = new Map(loadNodes(env.KESTREL_NODES).map((n) => [n.id, n]));
const failpoints = new Failpoints(env.KESTREL_FAILPOINTS);
// G-16: failpoints are never invisible.
if (failpoints.anyActive)
  log.warn(
    { failpoints: failpoints.describe() },
    "FAILPOINTS ARE ACTIVE: this process will fail on purpose",
  );

const ctx: Ctx = {
  db: createPrisma(env.DATABASE_URL),
  clock: systemClock,
  log,
  failpoints,
  signer: await TokenSigner.fromPem(
    readFileSync(env.TOKEN_PRIVATE_KEY_FILE, "utf8"),
  ),
  nodeClient: new HttpNodeClient(nodes),
  nodes,
  publicHostname: env.PUBLIC_HOSTNAME,
  metrics: createMetrics(),
  rateLimiter: new RateLimiter(systemClock),
  nodeCallTimeoutMs: 30_000,
  state: { waiters: 0, waitersByProject: new Map() },
  monotonic: () => performance.now(),
};

const sweeper = new Sweeper(ctx);
const publicApp = buildPublicApp(ctx);
const internalApp = buildInternalApp(ctx, sweeper);

await internalApp.listen({
  host: env.API_INTERNAL_HOST,
  port: env.API_INTERNAL_PORT,
});
await publicApp.listen({
  host: env.API_PUBLIC_HOST,
  port: env.API_PUBLIC_PORT,
});
sweeper.start();
log.info(
  {
    public: env.API_PUBLIC_PORT,
    internal: env.API_INTERNAL_PORT,
    nodes: [...nodes.keys()],
  },
  "api started",
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  sweeper.stop();
  await publicApp.close();
  await internalApp.close();
  await ctx.db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
