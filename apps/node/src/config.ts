import { z } from "zod";

export const Env = z.object({
  NODE_ID: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
  /** The shared secret with the API (K6), or the path of a file holding it. */
  NODE_SECRET_FILE: z.string().min(1),
  LISTEN_HOST: z.string().default("127.0.0.1"),
  LISTEN_PORT: z.coerce.number().int().default(7001),
  API_URL: z.string().default("http://127.0.0.1:8081"),
  /** Where the API reaches this agent, told to it at registration. */
  ADVERTISE_ADDRESS: z.string().optional(),
  STORE_PATH: z.string().min(1),
  SLOTS: z.coerce.number().int().positive(),
  POOL_TARGET: z.coerce.number().int().min(0).default(2),
  REFILL_AT_ONCE: z.coerce.number().int().positive().default(2),
  /** The pool may grow to this under demand; default: every slot. */
  POOL_MAX: z.coerce.number().int().min(0).optional(),
  /** Warm browsers the pool may hold beyond the slots (idle ones use little memory). Default 0. */
  POOL_HEADROOM: z.coerce.number().int().min(0).default(0),
  /** Pooled browsers that carry a recording volume (W3); default 1. */
  RECORDING_POOL: z.coerce.number().int().min(0).optional(),
  /** Stopped containers that may wait frozen for removal at once (deferred removal). */
  REAP_MAX_QUEUE: z.coerce.number().int().min(0).optional(),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  RUNTIME_IMAGE: z.string().min(1),
  /** Session network, by node: ksl-a, 172.30.1.0/24, egress at 172.30.1.1:3128 (v1 plan 4.12). */
  NETWORK: z.string().min(1),
  IFACE: z.string().min(1).max(15),
  SUBNET: z.string().min(1),
  BRIDGE_IP: z.string().min(1),
  EGRESS_PORT: z.coerce.number().int().default(3128),
  EGRESS_SOCKET: z.string().min(1),
  AGENT_SOCKET: z.string().min(1),
  CGROUP_PARENT: z.string().default("kestrel.slice"),
  /** W3. Give containers size-limited recording volumes (needs xfs project quotas on Docker's data root). */
  RECORDING: z.enum(["on", "off"]).default("on"),
  /** Seccomp profile JSON; omit to use Docker's default (decided by experiment V1). */
  SECCOMP_FILE: z.string().optional(),
  RUNTIME_VERSION: z.string().default("dev"),
  /**
   * What a browser is (ADR 0017): a Docker container, or a Firecracker microVM restored from a
   * snapshot of a running browser. A microVM node still uses Docker for sessions that record.
   */
  RUNTIME: z.enum(["docker", "microvm"]).default("docker"),
  MICROVM_DIR: z.string().default("/data/kestrel-vm"),
  FIRECRACKER_DIR: z.string().default("/opt/firecracker"),
  MICROVM_CGROUP: z.string().default("kestrel-vm"),
  /** The last octets of the session subnet VMs use; Docker's range is kept below them. */
  MICROVM_OCTETS: z
    .string()
    .regex(/^\d{1,3}-\d{1,3}$/)
    .default("128-254"),
  MICROVM_UID: z.coerce.number().int().positive().default(10002),
  MICROVM_NETNS_READY: z.coerce.number().int().min(0).default(8),
  /** "2M": clones' memory in hugetlbfs pages via the userfaultfd handler (when it is installed). */
  MICROVM_PAGES: z.enum(["2M", "4K"]).default("2M"),
  /** Certificate copy for the gateway (G16): Caddy's data directory, the hostname, the destination. */
  CADDY_DATA: z.string().optional(),
  PUBLIC_HOSTNAME: z.string().optional(),
  TLS_DIR: z.string().optional(),
  GATEWAY_UID: z.coerce.number().int().optional(),
  GATEWAY_GID: z.coerce.number().int().optional(),
  KESTREL_FAILPOINTS: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof Env>;
