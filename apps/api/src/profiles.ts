import {
  ProfileId,
  idToUuid,
  uuidToId,
  type CreateProfileRequest,
  type ListProfilesResponse,
  type Profile,
} from "@kestrel/contracts";
import type { Prisma } from "@kestrel/db";
import type {
  Profile as ProfileRow,
  ProfileVersion as ProfileVersionRow,
} from "@kestrel/db";
import {
  profileBlobKey,
  profilePrefix,
  type ProfileStore,
} from "@kestrel/shared";
import type { Auth, Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { newUuid, publicSessionId } from "./ids.js";
import { runTx } from "./lifecycle.js";

/**
 * P18 (docs/lld/p18-profiles.md section 6.1): `/v1/profiles`. Every query is scoped by the
 * caller's project, and a missing, deleted or other project's profile is the same `not_found`
 * (T-21, T-72). Profile content never passes through here: the API keeps rows and keys, the
 * nodes read and write blobs.
 */

/** What a deployment needs for profiles: the store, the master key, and the per-version cap. */
export interface ProfilesConfig {
  store: ProfileStore;
  /** 32 bytes, from the host's key file. Never logged, returned or sent anywhere. */
  master: Buffer;
  /** `PROFILE_MAX_BYTES`, sent to the node with each save. */
  maxBytes: number;
}

export function requireProfiles(ctx: Ctx, param?: string): ProfilesConfig {
  if (!ctx.profiles)
    throw new AppError(
      "invalid_request",
      "Profiles are not configured on this deployment.",
      param ? { param } : {},
    );
  return ctx.profiles;
}

/** The uuid inside a `prf_` id, or null if it cannot name a profile. */
export function profileUuid(id: string): string | null {
  return ProfileId.safeParse(id).success ? idToUuid(id) : null;
}

export const publicProfileId = (uuid: string): ProfileId =>
  uuidToId("prf", uuid) as ProfileId;

type Row = ProfileRow & { versions: ProfileVersionRow[] };

/** Only the committed (current) version is read alongside a profile. */
const CURRENT = {
  versions: { where: { state: "committed" }, take: 1 },
} as const satisfies Prisma.ProfileInclude;

export function toApiProfile(row: Row): Profile {
  const cur = row.versions.find((v) => v.version === row.currentVersion);
  return {
    id: publicProfileId(row.id),
    name: row.name,
    metadata: (row.metadata ?? {}) as Record<string, string>,
    version: row.currentVersion,
    bytes:
      cur?.bytes !== null && cur?.bytes !== undefined ? Number(cur.bytes) : 0,
    savedAt: cur?.committedAt?.toISOString() ?? null,
    savedBySessionId: cur ? publicSessionId(cur.sessionId) : null,
    chromeMajor: cur?.chromeMajor ?? null,
    inUseBy: row.writerSessionId ? publicSessionId(row.writerSessionId) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function findLive(ctx: Ctx, auth: Auth, id: string): Promise<Row> {
  const uuid = profileUuid(id);
  const row = uuid
    ? await ctx.db.profile.findFirst({
        where: { id: uuid, projectId: auth.projectId, deletedAt: null },
        include: CURRENT,
      })
    : null;
  if (!row) throw new AppError("not_found", "No such profile.");
  return row;
}

export async function createProfile(
  ctx: Ctx,
  auth: Auth,
  body: CreateProfileRequest,
): Promise<Profile> {
  requireProfiles(ctx);
  const now = new Date(ctx.clock.now());
  const row = await runTx(ctx, async (tx) => {
    // The project row is locked so two creates cannot both pass the count.
    const [project] = await tx.$queryRaw<{ max_profiles: number }[]>`
      SELECT max_profiles FROM projects WHERE id = ${auth.projectId}::uuid FOR UPDATE`;
    if (!project) throw new AppError("unauthorized", "Unknown project");
    const live = await tx.profile.count({
      where: { projectId: auth.projectId, deletedAt: null },
    });
    if (live >= project.max_profiles)
      throw new AppError(
        "quota_exceeded",
        `The project is at its limit of ${project.max_profiles} profiles.`,
        { retryable: false },
      );
    return tx.profile.create({
      data: {
        id: newUuid(),
        projectId: auth.projectId,
        name: body.name ?? null,
        metadata: body.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      },
      include: CURRENT,
    });
  }).catch((e: unknown) => {
    if ((e as { code?: string }).code === "P2002")
      throw new AppError(
        "conflict",
        "The project already has a profile with that name.",
        { retryable: false, param: "name" },
      );
    throw e;
  });
  ctx.log.info(
    { apiKeyId: auth.apiKeyId, profileId: row.id },
    "profile created",
  );
  return toApiProfile(row);
}

export async function getProfile(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<Profile> {
  requireProfiles(ctx);
  return toApiProfile(await findLive(ctx, auth, id));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function listProfiles(
  ctx: Ctx,
  auth: Auth,
  q: { limit: number; cursor?: string | undefined },
): Promise<ListProfilesResponse> {
  requireProfiles(ctx);
  const where: Prisma.ProfileWhereInput = {
    projectId: auth.projectId,
    deletedAt: null,
  };
  if (q.cursor) {
    const [ms, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    const t = Number(ms);
    if (
      !Number.isInteger(t) ||
      t < 0 ||
      t > 8.64e15 ||
      !id ||
      !UUID_RE.test(id)
    )
      throw new AppError("invalid_request", "Malformed cursor.", {
        param: "cursor",
      });
    where.OR = [
      { createdAt: { lt: new Date(t) } },
      { createdAt: new Date(t), id: { lt: id } },
    ];
  }
  const rows = await ctx.db.profile.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    include: CURRENT,
  });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toApiProfile),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(`${last.createdAt.getTime()}|${last.id}`).toString(
            "base64url",
          )
        : null,
  };
}

/**
 * Mark the profile deleted, clear its lock and its version rows, then remove its blobs. Readers
 * already running keep their browsers; a writer's later save finds nothing to commit (`deleted`).
 * Blobs that fail to delete now are collected by the sweeper as orphans.
 */
export async function deleteProfile(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<void> {
  const cfg = requireProfiles(ctx);
  const uuid = profileUuid(id);
  if (!uuid) throw new AppError("not_found", "No such profile.");
  const now = new Date(ctx.clock.now());
  const deleted = await runTx(ctx, async (tx) => {
    const { count } = await tx.profile.updateMany({
      where: { id: uuid, projectId: auth.projectId, deletedAt: null },
      data: {
        deletedAt: now,
        updatedAt: now,
        writerSessionId: null,
        writerSince: null,
      },
    });
    if (count === 0) return false;
    await tx.profileVersion.deleteMany({ where: { profileId: uuid } });
    return true;
  });
  if (!deleted) throw new AppError("not_found", "No such profile.");
  ctx.log.info({ apiKeyId: auth.apiKeyId, profileId: uuid }, "profile deleted");
  await deleteBlobs(ctx, cfg, auth.projectId, uuid);
}

/** Remove every blob of a profile. Best effort: the sweeper collects what is left. */
export async function deleteBlobs(
  ctx: Ctx,
  cfg: ProfilesConfig,
  projectUuid: string,
  profileUuid: string,
): Promise<void> {
  try {
    for (const e of await cfg.store.list(
      profilePrefix(projectUuid, profileUuid),
    ))
      await cfg.store.delete(e.key);
  } catch (e) {
    ctx.log.warn(
      {
        profileId: profileUuid,
        err: e instanceof Error ? e.message : String(e),
      },
      "profile blobs not removed; the sweeper will collect them",
    );
  }
}

/** Remove one version's blob. Best effort, as above. */
export async function deleteBlob(
  ctx: Ctx,
  cfg: ProfilesConfig,
  projectUuid: string,
  profileUuid: string,
  version: number,
): Promise<void> {
  try {
    await cfg.store.delete(profileBlobKey(projectUuid, profileUuid, version));
  } catch (e) {
    ctx.log.warn(
      {
        profileId: profileUuid,
        version,
        err: e instanceof Error ? e.message : String(e),
      },
      "profile blob not removed; the sweeper will collect it",
    );
  }
}
