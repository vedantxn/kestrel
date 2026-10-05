import {
  ApiKeyId,
  OrgId,
  ProjectId,
  uuidToId,
  idToUuid,
  type AdminCreateOrgRequest,
  type AdminCreateProjectRequest,
  type AdminNode,
  type AdminOrg,
  type ApiKey,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type EndReason,
  type ListAdminNodesResponse,
  type ListApiKeysResponse,
  type Project,
  type UsageDay,
  type UsageReport,
} from "@kestrel/contracts";
import type {
  ApiKey as ApiKeyRow,
  Org as OrgRow,
  Project as ProjectRow,
} from "@kestrel/db";
import { createApiKey } from "./auth.js";
import type { Auth, Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { newUuid } from "./ids.js";
import { NON_TERMINAL } from "./lifecycle.js";

/** P17 (`docs/lld/p17-dashboard.md`): the project, its keys and usage, and the admin calls. */

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? iso(d) : null);

/** The uuid inside a public id of the given kind, or null if it does not name one. */
function uuidOf(schema: { safeParse(v: unknown): { success: boolean } }) {
  return (id: string): string | null =>
    schema.safeParse(id).success ? idToUuid(id) : null;
}
const keyUuid = uuidOf(ApiKeyId);
const projectUuid = uuidOf(ProjectId);
const orgUuid = uuidOf(OrgId);

function toApiProject(
  row: ProjectRow & { org: OrgRow },
  admin: boolean,
): Project {
  return {
    id: uuidToId("prj", row.id) as Project["id"],
    name: row.name,
    org: { id: uuidToId("org", row.org.id) as OrgId, name: row.org.name },
    quotas: {
      maxConcurrentSessions: row.maxConcurrentSessions,
      createsPerMinute: row.createsPerMinute,
    },
    createdAt: iso(row.createdAt),
    admin,
  };
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: uuidToId("key", row.id) as ApiKey["id"],
    name: row.name,
    prefix: row.prefix,
    admin: row.admin,
    createdAt: iso(row.createdAt),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    revokedAt: isoOrNull(row.revokedAt),
  };
}

export async function getProject(ctx: Ctx, auth: Auth): Promise<Project> {
  const row = await ctx.db.project.findUniqueOrThrow({
    where: { id: auth.projectId },
    include: { org: true },
  });
  return toApiProject(row, auth.admin);
}

// --- API keys -----------------------------------------------------------------------------

export async function listApiKeys(
  ctx: Ctx,
  auth: Auth,
): Promise<ListApiKeysResponse> {
  const rows = await ctx.db.apiKey.findMany({
    where: { projectId: auth.projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return { data: rows.map(toApiKey) };
}

/** Keys made through the API are never admin keys (threat model T-57). */
async function newKey(
  ctx: Ctx,
  projectId: string,
  body: CreateApiKeyRequest,
): Promise<CreatedApiKey> {
  const { key, row } = await createApiKey(
    ctx.db,
    projectId,
    body.name,
    new Date(ctx.clock.now()),
  );
  return { ...toApiKey(row), key };
}

export async function createProjectApiKey(
  ctx: Ctx,
  auth: Auth,
  body: CreateApiKeyRequest,
): Promise<CreatedApiKey> {
  const created = await newKey(ctx, auth.projectId, body);
  ctx.log.info(
    { apiKeyId: auth.apiKeyId, created: created.id },
    "api key created",
  );
  return created;
}

export async function revokeApiKey(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<ApiKey> {
  const uuid = keyUuid(id);
  const where = uuid ? { id: uuid, projectId: auth.projectId } : null;
  const row = where ? await ctx.db.apiKey.findFirst({ where }) : null;
  if (!row || !where) throw new AppError("not_found", "No such API key.");
  if (row.id === auth.apiKeyId)
    throw new AppError("conflict", "A key cannot revoke itself.", {
      retryable: false,
    });
  // Conditional: the first revocation's time stands.
  const { count } = await ctx.db.apiKey.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: new Date(ctx.clock.now()) },
  });
  if (count > 0)
    ctx.log.info({ apiKeyId: auth.apiKeyId, revoked: id }, "api key revoked");
  return toApiKey(await ctx.db.apiKey.findUniqueOrThrow({ where }));
}

// --- Usage --------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export async function getUsage(
  ctx: Ctx,
  auth: Auth,
  q: { days: number },
): Promise<UsageReport> {
  const now = ctx.clock.now();
  const from = new Date(
    Math.floor(now / DAY_MS) * DAY_MS - (q.days - 1) * DAY_MS,
  );
  const inRange = { projectId: auth.projectId, createdAt: { gte: from } };

  const [rows, byEndReason, captchaSessions, live] = await Promise.all([
    ctx.db.$queryRaw<
      {
        date: string;
        sessions: number;
        failed: number;
        browser_seconds: number;
      }[]
    >`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             count(*)::int AS sessions,
             (count(*) FILTER (WHERE status = 'failed'))::int AS failed,
             coalesce(sum(browser_seconds), 0)::float8 AS browser_seconds
        FROM sessions
       WHERE project_id = ${auth.projectId}::uuid AND created_at >= ${from}
       GROUP BY 1`,
    ctx.db.session.groupBy({
      by: ["endReason"],
      where: { ...inRange, endReason: { not: null } },
      _count: { _all: true },
    }),
    ctx.db.session.count({
      where: { ...inRange, events: { some: { type: "captcha.detected" } } },
    }),
    ctx.db.session.count({
      where: { projectId: auth.projectId, status: { in: NON_TERMINAL } },
    }),
  ]);

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const days: UsageDay[] = [];
  for (let t = from.getTime(); t <= now; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const r = byDate.get(date);
    days.push({
      date,
      sessions: r?.sessions ?? 0,
      failed: r?.failed ?? 0,
      browserSeconds: r?.browser_seconds ?? 0,
    });
  }
  const sum = (f: (d: UsageDay) => number) =>
    days.reduce((n, d) => n + f(d), 0);

  return {
    from: iso(from),
    to: iso(new Date(now)),
    totals: {
      sessions: sum((d) => d.sessions),
      failed: sum((d) => d.failed),
      browserSeconds: sum((d) => d.browserSeconds),
      captchaSessions,
    },
    live,
    days,
    byEndReason: byEndReason
      .map((r) => ({
        endReason: r.endReason as EndReason,
        sessions: r._count._all,
      }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}

// --- Admin --------------------------------------------------------------------------------

/** A10/A13: there is no `forbidden`; to a project key the admin paths do not exist (T-57). */
export function requireAdmin(auth: Auth): void {
  if (!auth.admin) throw new AppError("not_found", "No such endpoint.");
}

export async function listNodes(ctx: Ctx): Promise<ListAdminNodesResponse> {
  const [nodes, counts] = await Promise.all([
    ctx.db.node.findMany({ orderBy: { id: "asc" } }),
    ctx.db.session.groupBy({
      by: ["nodeId"],
      where: { status: { in: NON_TERMINAL }, nodeId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const live = new Map(counts.map((c) => [c.nodeId, c._count._all]));
  return {
    data: nodes.map((n): AdminNode => ({
      id: n.id as AdminNode["id"],
      state: n.state,
      fenced: n.fenced,
      slotsTotal: n.slotsTotal,
      hotCount: n.hotCount,
      liveSessions: live.get(n.id) ?? 0,
      runtimeVersion: n.runtimeVersion,
      registeredAt: iso(n.registeredAt),
      lastHeartbeatAt: isoOrNull(n.lastHeartbeatAt),
      lostAt: isoOrNull(n.lostAt),
    })),
  };
}

export async function adminCreateOrg(
  ctx: Ctx,
  auth: Auth,
  body: AdminCreateOrgRequest,
): Promise<AdminOrg> {
  const row = await ctx.db.org.create({
    data: {
      id: newUuid(),
      name: body.name,
      createdAt: new Date(ctx.clock.now()),
    },
  });
  ctx.log.info({ apiKeyId: auth.apiKeyId, orgId: row.id }, "admin created org");
  return {
    id: uuidToId("org", row.id) as OrgId,
    name: row.name,
    createdAt: iso(row.createdAt),
  };
}

export async function adminCreateProject(
  ctx: Ctx,
  auth: Auth,
  body: AdminCreateProjectRequest,
): Promise<Project> {
  const orgId = orgUuid(body.orgId);
  const org = orgId
    ? await ctx.db.org.findUnique({ where: { id: orgId } })
    : null;
  if (!org) throw new AppError("not_found", "No such organisation.");
  const row = await ctx.db.project
    .create({
      data: {
        id: newUuid(),
        orgId: org.id,
        name: body.name,
        createdAt: new Date(ctx.clock.now()),
        ...(body.quotas?.maxConcurrentSessions !== undefined
          ? { maxConcurrentSessions: body.quotas.maxConcurrentSessions }
          : {}),
        ...(body.quotas?.createsPerMinute !== undefined
          ? { createsPerMinute: body.quotas.createsPerMinute }
          : {}),
      },
      include: { org: true },
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "P2002")
        throw new AppError(
          "conflict",
          "The organisation already has a project with that name.",
          { retryable: false, param: "name" },
        );
      throw e;
    });
  ctx.log.info(
    { apiKeyId: auth.apiKeyId, projectId: row.id },
    "admin created project",
  );
  return toApiProject(row, true);
}

export async function adminCreateApiKey(
  ctx: Ctx,
  auth: Auth,
  projectId: string,
  body: CreateApiKeyRequest,
): Promise<CreatedApiKey> {
  const uuid = projectUuid(projectId);
  const project = uuid
    ? await ctx.db.project.findUnique({
        where: { id: uuid },
        select: { id: true },
      })
    : null;
  if (!project) throw new AppError("not_found", "No such project.");
  const created = await newKey(ctx, project.id, body);
  ctx.log.info(
    { apiKeyId: auth.apiKeyId, projectId: project.id, created: created.id },
    "admin created api key",
  );
  return created;
}
