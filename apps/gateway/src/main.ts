import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { TokenVerifier, createLogger, parseEnv } from "@kestrel/shared";
import { Env } from "./config.js";
import { Gateway } from "./gateway.js";
import { createGatewayMetrics } from "./metrics.js";
import { AgentClient, RouteTable, watchRoutesFile } from "./routes.js";
import { TlsWatcher } from "./tls.js";

const env = parseEnv(Env);
const log = createLogger("gateway", env.LOG_LEVEL);
const metrics = createGatewayMetrics();
const table = new RouteTable();
const verifier = await TokenVerifier.fromPem(
  readFileSync(env.TOKEN_PUBLIC_KEY_FILE, "utf8"),
);

// W2: terminate our own TLS from the certificate copy, waiting until there is one.
let tlsWatcher: TlsWatcher | undefined;
let tls = null;
if (env.TLS_OFF)
  log.warn(
    "LOCAL MODE: no TLS. Tokens and CDP traffic cross the network in cleartext; use this only on a network where every device is trusted",
  );
else {
  if (!env.TLS_DIR) throw new Error("TLS_DIR is required unless TLS_OFF=1");
  tlsWatcher = new TlsWatcher(env.TLS_DIR, log);
  tls = await tlsWatcher.waitForFirst();
}

let agent: AgentClient | undefined;
const gateway = new Gateway({
  nodeId: env.NODE_ID,
  publicHostname: env.PUBLIC_HOSTNAME,
  publicPort: env.PUBLIC_PORT ?? env.LISTEN_PORT,
  publicSecure: !env.TLS_OFF,
  verifier,
  table,
  log,
  metrics,
  tls,
  ...(env.SLOTS ? { slots: env.SLOTS } : {}),
  ...(env.SESSION_BUFFER_SHARE_BYTES
    ? { limits: { sessionBufferShareBytes: env.SESSION_BUFFER_SHARE_BYTES } }
    : {}),
  onAttachments: (a) => agent?.sendAttachments(a),
});

if (env.AGENT_SOCKET) {
  agent = new AgentClient({
    socketPath: env.AGENT_SOCKET,
    gatewayId: env.GATEWAY_ID,
    table,
    log,
    attachments: () => gateway.attachments(),
  });
  agent.start();
}
const stopRoutesWatch = env.ROUTES_FILE
  ? watchRoutesFile(env.ROUTES_FILE, table, log)
  : undefined;

const addr = await gateway.start({
  host: env.LISTEN_HOST,
  port: env.LISTEN_PORT,
  reusePort: Boolean(env.REUSE_PORT),
});
tlsWatcher?.watch((m) => gateway.setTls(m));

// Metrics and health on a second, internal listener (A2).
const internal = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    metrics.routes.set(table.size);
    gateway.updateBufferMetrics();
    res.setHeader("content-type", metrics.registry.contentType);
    return res.end(await metrics.registry.metrics());
  }
  if (req.url === "/routes") {
    // Internal only (loopback): what the invariant checker compares with the node agent.
    return res.end(
      JSON.stringify({
        routes: table.ids(),
        attachments: gateway.attachments(),
      }),
    );
  }
  if (req.url === "/healthz")
    return res.end(
      JSON.stringify({
        status: "ok",
        agent: agent?.connected ?? null,
        routes: table.size,
      }),
    );
  res.statusCode = 404;
  res.end();
});
internal.listen(env.METRICS_PORT, env.METRICS_HOST);
log.info(
  {
    port: addr.port,
    node: env.NODE_ID,
    tls: Boolean(tls),
    sessionShareBytes: gateway.budget.shareBytes,
  },
  "gateway started",
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal, drainSeconds: env.DRAIN_SECONDS }, "draining");
  tlsWatcher?.stop();
  stopRoutesWatch?.();
  await gateway.stop(env.DRAIN_SECONDS * 1000);
  agent?.stop();
  internal.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
