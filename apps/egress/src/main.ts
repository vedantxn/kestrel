import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { createLogger, parseEnv } from "@kestrel/shared";
import { z } from "zod";
import { ControlServer } from "./control.js";
import { DenialLog } from "./denials.js";
import { createEgressMetrics } from "./metrics.js";
import { PolicyStore } from "./policy.js";
import { defaultUpstreamCa, EgressProxy } from "./proxy.js";
import { DnsResolve } from "./resolver.js";

const Env = z.object({
  /** The session bridge's host address (172.30.1.1 for node a): the only address this listens on (N5). */
  PROXY_HOST: z.string().min(1),
  PROXY_PORT: z.coerce.number().int().default(3128),
  CONTROL_SOCKET: z.string().min(1),
  /** The host's own public address and any others a session must never reach, comma separated. */
  BLOCKED_ADDRESSES: z
    .string()
    .min(
      1,
      "the host's public address (an Elastic IP is not on any interface) must be listed",
    ),
  METRICS_HOST: z.string().default("127.0.0.1"),
  METRICS_PORT: z.coerce.number().int().default(7301),
  LOG_LEVEL: z.string().default("info"),
  /**
   * PEM certificates trusted for `https://` upstream proxies in addition to the system's and
   * Node's own (a proxy with a private CA). Empty: none.
   */
  PROXY_CA_FILE: z.string().default(""),
});

const env = parseEnv(Env);

// One process serves every session (N12), so one bad socket must not take egress away from all of
// them. Log and keep serving; a genuinely broken process is replaced by the supervisor's restart,
// which fails closed (N13).
process.on("uncaughtException", (e) =>
  console.error(
    JSON.stringify({
      level: 60,
      msg: "uncaught exception; continuing",
      err: String(e),
    }),
  ),
);
process.on("unhandledRejection", (e) =>
  console.error(
    JSON.stringify({
      level: 60,
      msg: "unhandled rejection; continuing",
      err: String(e),
    }),
  ),
);
const log = createLogger("egress", env.LOG_LEVEL);
const metrics = createEgressMetrics();
const policies = new PolicyStore(); // starts empty, so a restart fails closed (N13)
const denials = new DenialLog();

// The host's own addresses are always blocked, so a session cannot call the platform's public endpoints.
const own = new Set<string>(
  env.BLOCKED_ADDRESSES.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
for (const addrs of Object.values(networkInterfaces()))
  for (const a of addrs ?? []) if (a.family === "IPv4") own.add(a.address);

const proxy = new EgressProxy({
  policies,
  resolver: new DnsResolve(),
  denials,
  metrics,
  log,
  blockedAddresses: own,
  upstreamCa: [
    ...defaultUpstreamCa(),
    ...(env.PROXY_CA_FILE ? [readFileSync(env.PROXY_CA_FILE, "utf8")] : []),
  ],
});
const control = new ControlServer(policies, denials, metrics, log);

await control.listen(env.CONTROL_SOCKET);
const port = await proxy.listen(env.PROXY_HOST, env.PROXY_PORT);

const internal = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.setHeader("content-type", metrics.registry.contentType);
    return res.end(await metrics.registry.metrics());
  }
  if (req.url === "/healthz")
    return res.end(
      JSON.stringify({ status: "ok", policiesRestored: policies.restored }),
    );
  res.statusCode = 404;
  res.end();
});
internal.listen(env.METRICS_PORT, env.METRICS_HOST);
log.info(
  { host: env.PROXY_HOST, port, blocked: own.size },
  "egress gateway started; refusing everything until policies are restored",
);

async function shutdown(): Promise<void> {
  await proxy.close();
  await control.close();
  internal.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
