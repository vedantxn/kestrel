import { z } from "zod";
import { ApiKeyId, NodeId, OrgId, ProjectId } from "./ids.js";
import { EndReason } from "./session.js";

/**
 * P17. What the dashboard reads besides sessions: the caller's project, its API keys and its
 * usage, and for admin keys the nodes and the calls that provision orgs, projects and keys
 * (`docs/lld/p17-dashboard.md`).
 */

const IsoTime = z.iso.datetime({ offset: true });
const Name = z.string().trim().min(1).max(64);

export const ProjectQuotas = z
  .object({
    /** A10: concurrent live sessions. */
    maxConcurrentSessions: z.number().int().min(1).max(10_000),
    /** A14: session creations per minute. */
    createsPerMinute: z.number().int().min(1).max(100_000),
  })
  .meta({ id: "ProjectQuotas" });
export type ProjectQuotas = z.infer<typeof ProjectQuotas>;

export const Project = z
  .object({
    id: ProjectId,
    name: z.string(),
    org: z.object({ id: OrgId, name: z.string() }),
    quotas: ProjectQuotas,
    createdAt: IsoTime,
    /** Whether the key making the request is an admin key. */
    admin: z.boolean(),
  })
  .meta({ id: "Project" });
export type Project = z.infer<typeof Project>;

// --- API keys -----------------------------------------------------------------------------

export const ApiKey = z
  .object({
    id: ApiKeyId,
    name: z.string(),
    /** `ksl_` and the first 4 characters; enough to recognise a key, never to use it. */
    prefix: z.string(),
    admin: z.boolean(),
    createdAt: IsoTime,
    lastUsedAt: IsoTime.nullable(),
    revokedAt: IsoTime.nullable(),
  })
  .meta({ id: "ApiKey" });
export type ApiKey = z.infer<typeof ApiKey>;

export const ListApiKeysResponse = z
  .object({ data: z.array(ApiKey) })
  .meta({ id: "ListApiKeysResponse" });
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponse>;

export const CreateApiKeyRequest = z
  .object({ name: Name })
  .strict()
  .meta({ id: "CreateApiKeyRequest" });
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const CreatedApiKey = ApiKey.extend({
  /** The key itself. Shown in this response only; only a hash is stored. */
  key: z.string(),
}).meta({ id: "CreatedApiKey" });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

// --- Usage --------------------------------------------------------------------------------

export const USAGE_MAX_DAYS = 90;

export const UsageQuery = z
  .object({
    /** Whole UTC days ending today, today included. */
    days: z.coerce.number().int().min(1).max(USAGE_MAX_DAYS).default(30),
  })
  .meta({ id: "UsageQuery" });
export type UsageQuery = z.infer<typeof UsageQuery>;

export const UsageDay = z
  .object({
    /** `YYYY-MM-DD`, UTC. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sessions: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Browser time of the sessions created that day. */
    browserSeconds: z.number().nonnegative(),
  })
  .meta({ id: "UsageDay" });
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageReport = z
  .object({
    from: IsoTime,
    to: IsoTime,
    totals: z.object({
      sessions: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      browserSeconds: z.number().nonnegative(),
      /** Sessions that met at least one CAPTCHA. */
      captchaSessions: z.number().int().nonnegative(),
    }),
    /** Sessions live now, whenever they were created. */
    live: z.number().int().nonnegative(),
    /** Every day in the range, oldest first, including days with nothing. */
    days: z.array(UsageDay),
    byEndReason: z.array(
      z.object({
        endReason: EndReason,
        sessions: z.number().int().nonnegative(),
      }),
    ),
  })
  .meta({ id: "UsageReport" });
export type UsageReport = z.infer<typeof UsageReport>;

// --- Admin (admin keys only) --------------------------------------------------------------

export const AdminNode = z
  .object({
    id: NodeId,
    state: z.enum(["active", "lost"]),
    fenced: z.boolean(),
    slotsTotal: z.number().int().nonnegative(),
    /** Browsers started and waiting for a session. */
    hotCount: z.number().int().nonnegative(),
    /** Sessions on the node that have not ended, in any project. */
    liveSessions: z.number().int().nonnegative(),
    runtimeVersion: z.string(),
    registeredAt: IsoTime,
    lastHeartbeatAt: IsoTime.nullable(),
    lostAt: IsoTime.nullable(),
  })
  .meta({ id: "AdminNode" });
export type AdminNode = z.infer<typeof AdminNode>;

export const ListAdminNodesResponse = z
  .object({ data: z.array(AdminNode) })
  .meta({ id: "ListAdminNodesResponse" });
export type ListAdminNodesResponse = z.infer<typeof ListAdminNodesResponse>;

export const AdminCreateOrgRequest = z
  .object({ name: Name })
  .strict()
  .meta({ id: "AdminCreateOrgRequest" });
export type AdminCreateOrgRequest = z.infer<typeof AdminCreateOrgRequest>;

export const AdminOrg = z
  .object({ id: OrgId, name: z.string(), createdAt: IsoTime })
  .meta({ id: "AdminOrg" });
export type AdminOrg = z.infer<typeof AdminOrg>;

export const AdminCreateProjectRequest = z
  .object({
    orgId: OrgId,
    name: Name,
    quotas: ProjectQuotas.partial().strict().optional(),
  })
  .strict()
  .meta({ id: "AdminCreateProjectRequest" });
export type AdminCreateProjectRequest = z.infer<
  typeof AdminCreateProjectRequest
>;
