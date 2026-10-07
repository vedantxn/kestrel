import {
  PROFILE_LIMITS,
  type ProfileSaveFailure,
  type Report,
  type SessionProfile,
  type StartProfile,
} from "@kestrel/contracts";
import {
  deriveProjectKey,
  newDataKey,
  profileBlobKey,
  unwrapDataKey,
  wrapDataKey,
} from "@kestrel/shared";
import type { Auth, Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { TERMINAL, addEvent, type Tx } from "./lifecycle.js";
import {
  profileUuid as toProfileUuid,
  publicProfileId,
  requireProfiles,
} from "./profiles.js";
import type { NodeNeeds } from "./scheduler.js";

/**
 * P18 (docs/lld/p18-profiles.md sections 4.1, 4.8 and 5): sessions with a profile. One writer at
 * a time, as a conditional update in the admission transaction; a version is committed only from
 * the lock holder and only on top of the version it started from; every way a writer can end
 * releases the lock exactly once, and writes one `profile.saved` or `profile.save_failed`.
 */

export interface AdmittedProfile {
  profileUuid: string;
  needs: NodeNeeds;
  /** The current version, if one has been saved: the session starts from it. */
  restore?: {
    version: number;
    chromeMajor: number;
    bytes: number;
    sha256: string;
    wrappedKey: Uint8Array;
  };
  /** `persist: true`: the version this session will write, and its data key (memory only). */
  save?: { version: number; dataKey: Buffer };
}

/**
 * In the admission transaction, after the project's quota check and before node choice. A writer
 * takes the lock with one conditional update, which also locks the row, so the version it reads
 * is the one it builds on. A refusal throws and rolls the admission back.
 */
export async function admitProfile(
  ctx: Ctx,
  tx: Tx,
  auth: Auth,
  opt: SessionProfile,
  sessionUuid: string,
  now: Date,
): Promise<AdmittedProfile> {
  const cfg = requireProfiles(ctx, "profile");
  const uuid = toProfileUuid(opt.id);
  const notFound = () =>
    new AppError("not_found", "No such profile.", { param: "profile.id" });
  if (!uuid) throw notFound();

  if (opt.persist) {
    // Take the lock; it also locks the row, so the read below cannot change under us.
    const taken = await tx.$executeRaw`
      UPDATE profiles SET writer_session_id = ${sessionUuid}::uuid, writer_since = ${now}
       WHERE id = ${uuid}::uuid AND project_id = ${auth.projectId}::uuid
         AND deleted_at IS NULL AND writer_session_id IS NULL`;
    if (taken === 0) {
      const live = await tx.profile.count({
        where: { id: uuid, projectId: auth.projectId, deletedAt: null },
      });
      if (live === 0) throw notFound();
      throw new AppError(
        "conflict",
        "Another session is saving into this profile; only one may at a time.",
        { retryable: true, param: "profile.id" },
      );
    }
  }

  // The current version and its row in one statement, so a reader never sees a profile whose
  // version moved on, or that was deleted, between two reads. A reader may get a version that was
  // superseded a moment ago: it is kept for ten minutes, longer than any start.
  const [cur] = await tx.$queryRaw<
    {
      current_version: number;
      state: string | null;
      bytes: bigint | null;
      sha256: string | null;
      chrome_major: number | null;
      wrapped_key: Uint8Array | null;
    }[]
  >`SELECT p.current_version, v.state, v.bytes, v.sha256, v.chrome_major, v.wrapped_key
      FROM profiles p
      LEFT JOIN profile_versions v
        ON v.profile_id = p.id AND v.version = p.current_version
     WHERE p.id = ${uuid}::uuid AND p.project_id = ${auth.projectId}::uuid
       AND p.deleted_at IS NULL`;
  if (!cur) throw notFound();
  const current = cur.current_version;

  let restore: AdmittedProfile["restore"];
  if (current > 0) {
    if (
      (cur.state !== "committed" && cur.state !== "superseded") ||
      cur.bytes === null ||
      !cur.sha256 ||
      !cur.wrapped_key
    )
      throw new Error(`profile ${uuid} has no saved version ${current}`);
    restore = {
      version: current,
      // A version from a node that did not say its Chrome needs a node that does.
      chromeMajor: cur.chrome_major ?? 1,
      bytes: Number(cur.bytes),
      sha256: cur.sha256,
      wrappedKey: cur.wrapped_key,
    };
  }

  let save: AdmittedProfile["save"];
  if (opt.persist) {
    const version = current + 1;
    const dataKey = newDataKey();
    const kek = deriveProjectKey(cfg.master, auth.projectId);
    // A pending row left at this number by a writer whose release was lost is stale: the lock is ours.
    await tx.profileVersion.deleteMany({
      where: { profileId: uuid, version, state: "pending" },
    });
    await tx.profileVersion.create({
      data: {
        profileId: uuid,
        version,
        state: "pending",
        sessionId: sessionUuid,
        wrappedKey: new Uint8Array(wrapDataKey(kek, dataKey, uuid, version)),
        createdAt: now,
      },
    });
    save = { version, dataKey };
  }

  return {
    profileUuid: uuid,
    // Only nodes that report their Chrome can take a profile session at all; a restore needs one
    // at least as new as the Chrome that saved it.
    needs: {
      minChromeMajor: Math.max(1, restore?.chromeMajor ?? 1),
      warm: restore !== undefined,
    },
    ...(restore ? { restore } : {}),
    ...(save ? { save } : {}),
  };
}

/** `StartRequest.profile`, with the restore key unwrapped. Throws if it does not unwrap. */
export function startProfile(
  ctx: Ctx,
  projectUuid: string,
  p: AdmittedProfile,
): StartProfile {
  const cfg = requireProfiles(ctx, "profile");
  const out: StartProfile = { profileId: publicProfileId(p.profileUuid) };
  if (p.restore) {
    const kek = deriveProjectKey(cfg.master, projectUuid);
    out.restore = {
      version: p.restore.version,
      chromeMajor: p.restore.chromeMajor,
      bytes: p.restore.bytes,
      sha256: p.restore.sha256,
      key: unwrapDataKey(
        kek,
        p.restore.wrappedKey,
        p.profileUuid,
        p.restore.version,
      ).toString("base64"),
    };
  }
  if (p.save)
    out.save = {
      version: p.save.version,
      key: p.save.dataKey.toString("base64"),
      maxBytes: cfg.maxBytes,
    };
  return out;
}

const OUTCOME_TYPES = ["profile.saved", "profile.save_failed"];

/** Each writer session gets one outcome event, whichever path writes it first. */
async function hasOutcome(tx: Tx, sessionUuid: string): Promise<boolean> {
  return (
    (await tx.sessionEvent.count({
      where: { sessionId: sessionUuid, type: { in: OUTCOME_TYPES } },
    })) > 0
  );
}

/** `profile.save_failed` for a writer, unless it already has its outcome. */
export async function profileSaveFailed(
  tx: Tx,
  sessionUuid: string,
  profileUuid: string,
  reason: ProfileSaveFailure,
  at: Date,
): Promise<void> {
  // A writer always has its session row; one that does not has nowhere to record it.
  if (!(await tx.session.count({ where: { id: sessionUuid } }))) return;
  await failedEvent(tx, sessionUuid, profileUuid, reason, at);
}

async function failedEvent(
  tx: Tx,
  sessionUuid: string,
  profileUuid: string,
  reason: ProfileSaveFailure,
  at: Date,
  dedupeKey?: string,
): Promise<void> {
  if (await hasOutcome(tx, sessionUuid)) return;
  await addEvent(
    tx,
    sessionUuid,
    {
      type: "profile.save_failed",
      data: { profileId: publicProfileId(profileUuid), reason },
    },
    at,
    dedupeKey,
  );
}

/**
 * Release a writer's lock without a version: clear it if this session still holds it, drop its
 * pending version, and record why. False if it held no lock.
 */
export async function releaseProfileLock(
  tx: Tx,
  sessionUuid: string,
  reason: ProfileSaveFailure,
  at: Date,
): Promise<boolean> {
  const held = await tx.profile.findFirst({
    where: { writerSessionId: sessionUuid },
    select: { id: true },
  });
  if (!held) return false;
  const { count } = await tx.profile.updateMany({
    where: { id: held.id, writerSessionId: sessionUuid },
    data: { writerSessionId: null, writerSince: null },
  });
  await tx.profileVersion.deleteMany({
    where: { profileId: held.id, sessionId: sessionUuid, state: "pending" },
  });
  if (count === 0) return false;
  await failedEvent(tx, sessionUuid, held.id, reason, at);
  return true;
}

/**
 * Section 5, rules 1 and 2: when a session reaches its terminal status, a lock it can no longer
 * save into is released at once: it never became ready, or its node was lost.
 */
export async function releaseOnEnd(
  tx: Tx,
  sessionUuid: string,
  ended: { readyAt: Date | null; endReason: string },
  at: Date,
): Promise<void> {
  if (ended.readyAt === null)
    await releaseProfileLock(tx, sessionUuid, "not_started", at);
  else if (ended.endReason === "node_lost")
    await releaseProfileLock(tx, sessionUuid, "node_lost", at);
}

/**
 * Section 5, rule 3: a heartbeat from a settled node (no reports waiting) that no longer holds a
 * terminal writer session, three heartbeats after it ended: its report was lost for good.
 */
export async function releaseUnreported(
  tx: Tx,
  nodeId: string,
  heldUuids: string[],
  floor: Date,
  now: Date,
): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM profiles p JOIN sessions s ON s.id = p.writer_session_id
     WHERE s.node_id = ${nodeId}
       AND s.status::text = ANY(${TERMINAL}::text[])
       AND s.ended_at <= ${floor}
       AND NOT (s.id = ANY(${heldUuids}::uuid[]))`;
  let n = 0;
  for (const r of rows)
    if (await releaseProfileLock(tx, r.id, "no_report", now)) n++;
  return n;
}

/**
 * Section 4.8: a node's `profile` report. `saved` is committed only if this session still holds
 * the lock, its pending row is there, the profile has not moved on and the project stays within
 * its bytes; otherwise, and for `failed`, the lock is released. A repeated delivery changes
 * nothing (the dedupe key on the outcome event, and every update is conditional).
 */
export async function applyProfileReport(
  ctx: Ctx,
  tx: Tx,
  nodeId: string,
  sessionUuid: string,
  r: Extract<Report, { kind: "profile" }>,
  at: Date,
  dedupeKey: string,
): Promise<void> {
  if (await tx.sessionEvent.findUnique({ where: { dedupeKey } })) return;
  const profileUuid = toProfileUuid(r.profileId);
  if (!profileUuid) return;
  // Lock the profile row: the checks below and the commit see one state.
  const [profile] = await tx.$queryRaw<
    {
      project_id: string;
      current_version: number;
      writer_session_id: string | null;
      deleted_at: Date | null;
    }[]
  >`SELECT project_id, current_version, writer_session_id, deleted_at
      FROM profiles WHERE id = ${profileUuid}::uuid FOR UPDATE`;
  if (!profile) return;
  const session = await tx.session.findUnique({
    where: { id: sessionUuid },
    select: { projectId: true },
  });
  if (!session || session.projectId !== profile.project_id) return;

  const fail = async (reason: ProfileSaveFailure) => {
    if (profile.writer_session_id === sessionUuid)
      await releaseProfileLock(tx, sessionUuid, reason, at);
    else await failedEvent(tx, sessionUuid, profileUuid, reason, at);
  };

  if (r.outcome === "failed") return fail(r.reason ?? "unclean_end");
  if (profile.deleted_at) return fail("deleted");
  const pending = await tx.profileVersion.findUnique({
    where: {
      profileId_version: { profileId: profileUuid, version: r.version },
    },
  });
  if (
    profile.writer_session_id !== sessionUuid ||
    profile.current_version !== r.version - 1 ||
    !pending ||
    pending.state !== "pending" ||
    pending.sessionId !== sessionUuid ||
    r.bytes === undefined ||
    r.sha256 === undefined
  )
    return fail("stale");

  // The project's bytes: every live profile's current version, this one's replaced by the new one.
  const [usage] = await tx.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT sum(v.bytes)::bigint AS bytes FROM profile_versions v
      JOIN profiles p ON p.id = v.profile_id
     WHERE p.project_id = ${profile.project_id}::uuid AND p.deleted_at IS NULL
       AND v.state = 'committed' AND v.profile_id <> ${profileUuid}::uuid`;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: profile.project_id },
    select: { maxProfileBytes: true },
  });
  if ((usage?.bytes ?? 0n) + BigInt(r.bytes) > project.maxProfileBytes)
    return fail("project_quota");

  const node = await tx.node.findUnique({
    where: { id: nodeId },
    select: { chromeMajor: true },
  });
  const committed = await tx.profileVersion.updateMany({
    where: {
      profileId: profileUuid,
      version: r.version,
      sessionId: sessionUuid,
      state: "pending",
    },
    data: {
      state: "committed",
      bytes: BigInt(r.bytes),
      sha256: r.sha256,
      // The saving node's own pinned Chrome, from its registration: never what a browser said.
      chromeMajor: node && node.chromeMajor > 0 ? node.chromeMajor : null,
      committedAt: at,
    },
  });
  const moved = await tx.profile.updateMany({
    where: {
      id: profileUuid,
      writerSessionId: sessionUuid,
      deletedAt: null,
      currentVersion: r.version - 1,
    },
    data: {
      currentVersion: r.version,
      writerSessionId: null,
      writerSince: null,
      updatedAt: at,
    },
  });
  // Both were checked under the row lock above; anything else is a bug, and rolls back.
  if (committed.count !== 1 || moved.count !== 1)
    throw new Error("profile commit did not apply");
  await tx.profileVersion.updateMany({
    where: {
      profileId: profileUuid,
      version: r.version - 1,
      state: "committed",
    },
    data: { state: "superseded", supersededAt: at },
  });
  await addEvent(
    tx,
    sessionUuid,
    {
      type: "profile.saved",
      data: {
        profileId: publicProfileId(profileUuid),
        version: r.version,
        bytes: r.bytes,
      },
    },
    at,
    dedupeKey,
  );
  ctx.log.info(
    { profileId: profileUuid, version: r.version, bytes: r.bytes },
    "profile version committed",
  );
}

/** How long an unreferenced blob is left alone: longer than any save takes to be reported. */
export const ORPHAN_BLOB_AGE_MS = 60 * 60_000;

/**
 * The sweeper's collection (section 5): superseded versions past their 10 minutes, with their
 * blobs; blobs with no version row (a stale or failed save, a deleted profile whose blobs did not
 * all go at once) after an hour; and temporary files left by a crash. Outside any transaction:
 * a store call is never made while a database transaction is open.
 */
export async function collectProfiles(ctx: Ctx, nowMs: number): Promise<void> {
  const cfg = ctx.profiles;
  if (!cfg) return;
  const old = await ctx.db.profileVersion.findMany({
    where: {
      state: "superseded",
      supersededAt: { lt: new Date(nowMs - PROFILE_LIMITS.supersededKeepMs) },
    },
    select: {
      profileId: true,
      version: true,
      profile: { select: { projectId: true } },
    },
    take: 200,
  });
  for (const v of old) {
    try {
      await cfg.store.delete(
        profileBlobKey(v.profile.projectId, v.profileId, v.version),
      );
      await ctx.db.profileVersion.deleteMany({
        where: {
          profileId: v.profileId,
          version: v.version,
          state: "superseded",
        },
      });
    } catch (e) {
      ctx.log.warn(
        { profileId: v.profileId, version: v.version, err: String(e) },
        "superseded profile version not collected",
      );
    }
  }

  const blobs = await cfg.store.list("");
  const stale = blobs.filter((b) => nowMs - b.mtimeMs >= ORPHAN_BLOB_AGE_MS);
  for (const b of stale) {
    const [project, , profile, file] = b.key.split("/");
    const version = Number(file!.slice(0, -".kpf".length));
    const row = await ctx.db.profileVersion.findFirst({
      where: {
        profileId: profile!,
        version,
        profile: { projectId: project!, deletedAt: null },
      },
      select: { state: true },
    });
    if (row) continue;
    await cfg.store.delete(b.key).catch(() => {});
    ctx.metrics.sweeper.inc({ action: "profile_orphan" });
  }
  await cfg.store.sweep(10 * 60_000, nowMs);
}
