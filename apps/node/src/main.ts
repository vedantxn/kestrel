import { readFileSync } from "node:fs";
import {
  Failpoints,
  createLogger,
  parseEnv,
  systemClock,
} from "@kestrel/shared";
import { NodeAgent, DEFAULT_CONFIG } from "./agent.js";
import { HttpApiClient } from "./api-client.js";
import { copyCertificate } from "./cert-copy.js";
import { Env } from "./config.js";
import { DockerodeDriver, DockerVolumes } from "./docker.js";
import { UnixEgressClient } from "./egress-client.js";
import { Firewall } from "./firewall.js";
import { GatewayHub } from "./gateway-hub.js";
import { createNodeServer } from "./http.js";
import { HttpRuntimeClient } from "./runtime-client.js";
import { Store } from "./store.js";

const env = parseEnv(Env);
const log = createLogger(`node-${env.NODE_ID}`, env.LOG_LEVEL);
const failpoints = new Failpoints(env.KESTREL_FAILPOINTS);
if (failpoints.anyActive)
  log.warn(
    { failpoints: failpoints.describe() },
    "FAILPOINTS ARE ACTIVE: this process will fail on purpose",
  );

const secret = readFileSync(env.NODE_SECRET_FILE, "utf8").trim();
const store = new Store(env.STORE_PATH);
// A hung Docker call must not wedge a teardown (and, with it, shutdown) forever.
const docker = new DockerodeDriver(env.NODE_ID, env.NETWORK, {
  socketPath: env.DOCKER_SOCKET,
  timeout: 60_000,
});
await docker.ensureNetwork({
  name: env.NETWORK,
  iface: env.IFACE,
  subnet: env.SUBNET,
  gateway: env.BRIDGE_IP,
});
const firewall = new Firewall({
  nodeId: env.NODE_ID,
  iface: env.IFACE,
  bridgeIp: env.BRIDGE_IP,
  egressPort: env.EGRESS_PORT,
});
const egress = new UnixEgressClient(env.EGRESS_SOCKET);

// eslint-disable-next-line prefer-const -- the hub's callbacks need the agent, and the agent needs the hub
let agent!: NodeAgent;
const hub = new GatewayHub({
  log,
  routes: () => agent.routes(),
  onAttachments: (g, a) => agent.handleAttachments(g, a),
  onGone: (g) => agent.handleGatewayGone(g),
});

agent = new NodeAgent({
  config: {
    ...DEFAULT_CONFIG,
    nodeId: env.NODE_ID,
    slotsTotal: env.SLOTS,
    poolTarget: env.POOL_TARGET,
    refillAtOnce: env.REFILL_AT_ONCE,
    address:
      env.ADVERTISE_ADDRESS ?? `http://${env.LISTEN_HOST}:${env.LISTEN_PORT}`,
    runtimeVersion: env.RUNTIME_VERSION,
  },
  store,
  docker,
  runtime: new HttpRuntimeClient(),
  egress,
  firewall,
  hub,
  api: new HttpApiClient(env.API_URL, secret),
  clock: systemClock,
  log,
  failpoints,
  ...(env.RECORDING === "on"
    ? {
        volumes: new DockerVolumes(env.NODE_ID, {
          socketPath: env.DOCKER_SOCKET,
          timeout: 60_000,
        }),
      }
    : {}),
  dockerSpec: {
    nodeId: env.NODE_ID,
    image: env.RUNTIME_IMAGE,
    network: env.NETWORK,
    bridgeIp: env.BRIDGE_IP,
    egressPort: env.EGRESS_PORT,
    cgroupParent: env.CGROUP_PARENT,
    seccompProfile: env.SECCOMP_FILE
      ? readFileSync(env.SECCOMP_FILE, "utf8")
      : null,
  },
});

// Routine boot (I13): firewall verified, leftovers torn down, policies pushed back, then serve.
const owner =
  env.GATEWAY_UID !== undefined && env.GATEWAY_GID !== undefined
    ? { uid: env.GATEWAY_UID, gid: env.GATEWAY_GID }
    : undefined;
await hub.listen(env.AGENT_SOCKET, owner);
for (;;) {
  try {
    await agent.boot();
    break;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "boot step failed; retrying (is the egress gateway up?)",
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const server = createNodeServer(agent, secret, log);
await new Promise<void>((r) =>
  server.listen(env.LISTEN_PORT, env.LISTEN_HOST, r),
);

// Register with the API, retrying until it is reachable. Sessions already running are unaffected by its absence.
void (async () => {
  for (;;) {
    try {
      await agent.register();
      log.info({ epoch: store.epoch }, "registered with the API");
      return;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "registration failed; retrying",
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();

// G16: keep a copy of Caddy's certificate where the gateway can read it.
if (env.CADDY_DATA && env.PUBLIC_HOSTNAME && env.TLS_DIR) {
  const copy = (): void => {
    // A failure here (a full disk, a bad directory) must never take down a root process that is running sessions.
    try {
      const r = copyCertificate({
        caddyData: env.CADDY_DATA!,
        hostname: env.PUBLIC_HOSTNAME!,
        outDir: env.TLS_DIR!,
        ...(owner ? { owner } : {}),
      });
      if (r.copied) log.info("copied the certificate for the gateway");
      else if (r.reason !== "unchanged")
        log.debug({ reason: r.reason }, "certificate not copied");
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not copy the certificate; will retry",
      );
    }
  };
  copy();
  setInterval(copy, 30_000).unref();
}

agent.startLoops();
docker.onEvent((e) => {
  if (e.action === "die" || e.action === "oom")
    void agent.reconcile().catch(() => undefined);
});
log.info(
  { port: env.LISTEN_PORT, node: env.NODE_ID, slots: env.SLOTS },
  "node agent started",
);

// A restart must not kill sessions: containers keep running and boot recovery picks them up again.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down; containers are left running");
  agent.stopLoops();
  await agent.idle();
  server.close();
  await hub.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
