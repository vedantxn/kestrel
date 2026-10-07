import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Failpoints,
  FsProfileStore,
  createLogger,
  parseEnv,
  systemClock,
} from "@kestrel/shared";
import { NodeAgent, DEFAULT_CONFIG } from "./agent.js";
import { HttpApiClient } from "./api-client.js";
import { copyCertificate } from "./cert-copy.js";
import { Env } from "./config.js";
import { DockerodeDriver, DockerVolumes, type DockerDriver } from "./docker.js";
import { MicroVmDriver, RoutedDriver, exec } from "./microvm.js";
import { UnixEgressClient } from "./egress-client.js";
import { Firewall } from "./firewall.js";
import { GatewayHub } from "./gateway-hub.js";
import { createHarnessServer, listenHarness } from "./harness.js";
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

const harness = env.KESTREL_HARNESS === "on";
if (harness)
  log.warn(
    "THE HARNESS SURFACE IS ON: probe policies and probe VMs can be made (never in production)",
  );

const secret = readFileSync(env.NODE_SECRET_FILE, "utf8").trim();

// P18: profiles need the store and the pinned Chrome's version; without both, this node takes no
// profile session (the API sends none to a node that did not say its Chrome).
const chromeMajor = env.CHROME_VERSION
  ? Number(env.CHROME_VERSION.split(".")[0])
  : undefined;
const profileStore =
  env.PROFILE_STORE_DIR && chromeMajor !== undefined
    ? new FsProfileStore(
        env.PROFILE_STORE_DIR,
        env.PROFILE_STORE_UID !== undefined
          ? {
              uid: env.PROFILE_STORE_UID,
              gid: env.PROFILE_STORE_GID ?? env.PROFILE_STORE_UID,
            }
          : undefined,
      )
    : undefined;
if (env.PROFILE_STORE_DIR && chromeMajor === undefined)
  log.warn(
    "PROFILE_STORE_DIR is set without CHROME_VERSION: no profile sessions",
  );
const store = new Store(env.STORE_PATH);
// A hung Docker call must not wedge a teardown (and, with it, shutdown) forever.
const docker = new DockerodeDriver(env.NODE_ID, env.NETWORK, {
  socketPath: env.DOCKER_SOCKET,
  timeout: 60_000,
});
const [vmFirst, vmLast] = env.MICROVM_OCTETS.split("-").map(Number) as [
  number,
  number,
];
await docker.ensureNetwork({
  name: env.NETWORK,
  iface: env.IFACE,
  subnet: env.SUBNET,
  gateway: env.BRIDGE_IP,
  // Docker allocates below the microVMs' addresses, so the two never collide.
  ipRange: env.SUBNET.replace(/\.\d+\/24$/, ".0/25"),
});
let driver: DockerDriver = docker;
let microvm: MicroVmDriver | undefined;
if (env.RUNTIME === "microvm") {
  microvm = new MicroVmDriver(
    {
      nodeId: env.NODE_ID,
      firecracker: `${env.FIRECRACKER_DIR}/firecracker`,
      jailer: `${env.FIRECRACKER_DIR}/jailer`,
      dir: env.MICROVM_DIR,
      cgroupParent: env.MICROVM_CGROUP,
      bridge: env.IFACE,
      bridgeIp: env.BRIDGE_IP,
      egressPort: env.EGRESS_PORT,
      subnetPrefix: env.SUBNET.split(".").slice(0, 3).join("."),
      octets: [vmFirst, vmLast],
      vmUid: env.MICROVM_UID,
      vmGid: env.MICROVM_UID,
      netnsReady: env.MICROVM_NETNS_READY,
      vcpus: 1,
      memMib: 2048,
      ...(env.MICROVM_PAGES === "2M" &&
      existsSync(`${env.FIRECRACKER_DIR}/uffd_on_demand_handler`)
        ? { uffdHandler: `${env.FIRECRACKER_DIR}/uffd_on_demand_handler` }
        : {}),
    },
    { run: exec, log },
  );
  await microvm.start();
  driver = new RoutedDriver(microvm, docker, {
    profilesOnDocker: env.MICROVM_PROFILES === "docker",
  });
  log.info(
    {
      octets: env.MICROVM_OCTETS,
      pages: microvm.pages,
      recording: env.MICROVM_RECORDING,
      profiles: env.MICROVM_PROFILES,
    },
    "browsers are microVMs",
  );
}
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
    ...(env.POOL_MAX !== undefined ? { poolMax: env.POOL_MAX } : {}),
    poolHeadroom: env.POOL_HEADROOM,
    ...(env.REAP_MAX_QUEUE !== undefined
      ? { reapMaxQueue: env.REAP_MAX_QUEUE }
      : {}),
    ...(env.RECORDING_POOL !== undefined
      ? { recordingPool: env.RECORDING_POOL }
      : {}),
    // A microVM's recording is pulled out of it into a volume the agent writes (needs the
    // volumes directory mounted read-write: docker-compose.microvm.yml).
    recordingSink:
      env.RUNTIME === "microvm" && env.MICROVM_RECORDING === "vm"
        ? "pull"
        : "volume",
    address:
      env.ADVERTISE_ADDRESS ?? `http://${env.LISTEN_HOST}:${env.LISTEN_PORT}`,
    runtimeVersion: env.RUNTIME_VERSION,
    // P18: a Docker node that takes profile sessions keeps one warm browser; a microVM node
    // restores a warm clone instead, unless its profile sessions run in Docker containers
    // (MICROVM_PROFILES=docker). A node without profiles keeps none (the agent also ensures it).
    warmPool:
      env.WARM_POOL ??
      (!profileStore ||
      (env.RUNTIME === "microvm" && env.MICROVM_PROFILES === "vm")
        ? 0
        : 1),
    ...(profileStore && chromeMajor !== undefined ? { chromeMajor } : {}),
  },
  store,
  docker: driver,
  runtime: new HttpRuntimeClient(),
  egress,
  firewall,
  hub,
  api: new HttpApiClient(env.API_URL, secret),
  clock: systemClock,
  log,
  failpoints,
  // The host's /proc/meminfo (a container sees the host's figures): deferred removal checks it.
  memAvailableMb: () => {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(
        readFileSync("/proc/meminfo", "utf8"),
      );
      return m ? Math.floor(Number(m[1]) / 1024) : undefined;
    } catch {
      return undefined;
    }
  },
  ...(microvm ? { microvm } : {}),
  ...(profileStore ? { profileStore } : {}),
  harness,
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
const harnessServer = harness
  ? createHarnessServer(agent, secret, log)
  : undefined;
if (harnessServer)
  await listenHarness(
    harnessServer,
    env.HARNESS_SOCKET ?? join(dirname(env.AGENT_SOCKET), "harness.sock"),
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
driver.onEvent((e) => {
  if (e.action === "die" || e.action === "oom") agent.containerDied(e.id);
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
  harnessServer?.close();
  await hub.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
