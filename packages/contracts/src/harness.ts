import { z } from "zod";

/**
 * The node agent's surface for the test and benchmark harness (`bench/framework`, docs/harness.md).
 *
 *  - `GET /v1/state`, on the agent's listener and authenticated like the node protocol: everything
 *    the agent holds, for the invariant checker (H5). Always served.
 *  - The probe controls (`HARNESS_PATHS`), only when the agent runs with `KESTREL_HARNESS=on`, and
 *    then only on a root-only unix socket beside the agent's other sockets, never on its TCP
 *    listener. They let the isolation suite give a probe container an egress policy the agent's
 *    reconciliation keeps (instead of clearing it as unowned), and make a probe microVM from the
 *    template (threat model G-23). Off by default; when off, the socket does not exist.
 */
export const AGENT_STATE_PATH = "/v1/state";

export const HARNESS_PATHS = {
  /** `PUT /<ip>` (`ProbePolicyRequest`) gives a probe's address a policy; `DELETE /<ip>` takes it away. */
  probePolicy: "/v1/harness/probe-policy",
  /** `POST` makes a probe VM; `POST /<id>/probe` (`ProbeRequest`) runs a probe in it; `DELETE /<id>` removes it. */
  probeVm: "/v1/harness/probe-vm",
} as const;

/** The longest a probe lease or probe VM lives; the agent removes it then even if the harness does not. */
export const HARNESS_MAX_TTL_MS = 10 * 60_000;

export const ProbePolicyRequest = z.strictObject({
  ttlMs: z.number().int().min(1000).max(HARNESS_MAX_TTL_MS),
});
export type ProbePolicyRequest = z.infer<typeof ProbePolicyRequest>;

/** A probe's lease: an address with a policy, as the agent holds it (and as the egress gateway lists it). */
export const ProbeLease = z.object({
  ip: z.string(),
  sessionId: z.string(),
  /** Epoch ms on the agent's clock. */
  expiresAt: z.number(),
});
export type ProbeLease = z.infer<typeof ProbeLease>;

export const ProbeVmRequest = z.strictObject({
  ttlMs: z.number().int().min(1000).max(HARNESS_MAX_TTL_MS),
});
export type ProbeVmRequest = z.infer<typeof ProbeVmRequest>;

export const ProbeVm = z.object({
  id: z.string(),
  address: z.string(),
  expiresAt: z.number(),
});
export type ProbeVm = z.infer<typeof ProbeVm>;

/** A microVM node's runtime, as the invariant checker needs it to find and judge each VM (G-25). */
export const MicroVmRuntimeView = z.object({
  /** Holds `jail/`, `meta/` and `template/`. */
  dir: z.string(),
  /** The cgroup v2 parent of every VM's cgroup, relative to the cgroup root. */
  cgroupParent: z.string(),
  uid: z.number().int(),
  gid: z.number().int(),
  vcpus: z.number().int(),
  memMib: z.number().int(),
  subnetPrefix: z.string(),
  octets: z.tuple([z.number().int(), z.number().int()]),
  bridge: z.string(),
  bridgeIp: z.string(),
  egressPort: z.number().int(),
  pages: z.enum(["2M", "4K"]),
  /** Namespaces kept made ahead of need. */
  netnsTarget: z.number().int(),
  /** This node's VM network namespaces by last octet: made and waiting, used by a VM, being made. */
  netns: z.object({
    ready: z.array(z.number().int()),
    inUse: z.array(z.number().int()),
    making: z.array(z.number().int()),
  }),
});
export type MicroVmRuntimeView = z.infer<typeof MicroVmRuntimeView>;

export const AgentState = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      state: z.string(),
      address: z.string().nullable(),
      containerId: z.string().nullable(),
    }),
  ),
  pool: z.array(
    z.object({
      containerId: z.string(),
      address: z.string(),
      state: z.string(),
    }),
  ),
  pendingReports: z.number().int(),
  slotsTotal: z.number().int(),
  poolHeadroom: z.number().int().default(0),
  /** Containers (or VMs) on their way out: frozen for the reaper, or being removed now. */
  retiring: z.array(z.string()).default([]),
  /**
   * Containers (or VMs) being made and not yet recorded, by the `kestrel.creation` label each
   * carries: Docker can list one before the agent's store holds it.
   */
  creating: z.array(z.string()).default([]),
  admitting: z.boolean(),
  failpoints: z.record(z.string(), z.string()),
  runtime: z.enum(["docker", "microvm"]).default("docker"),
  microvm: MicroVmRuntimeView.optional(),
  harness: z
    .object({
      enabled: z.boolean(),
      probePolicies: z.array(ProbeLease),
      probeVms: z.array(ProbeVm),
    })
    .default({ enabled: false, probePolicies: [], probeVms: [] }),
});
export type AgentState = z.infer<typeof AgentState>;
export type AgentStateInput = z.input<typeof AgentState>;

/** The label each container (and VM) carries while it is being made: see `AgentState.creating`. */
export const CREATION_LABEL = "kestrel.creation";
