import { NodeId, TIMINGS, type SessionOptions } from "@kestrel/contracts";
import type { Ctx, Auth } from "./context.js";
import { AppError } from "./errors.js";
import { NON_TERMINAL, addEvent, type Tx } from "./lifecycle.js";
import { newUuid } from "./ids.js";
import { admitProfile, type AdmittedProfile } from "./profile-sessions.js";

/**
 * K2. A node's free capacity is its slots minus its sessions not yet confirmed removed.
 * Pool containers are invisible here: the node keeps its pool within what sessions leave free (G4-G6).
 */
interface Candidate {
  id: string;
  epoch: number;
  free: number;
  hot: boolean;
  hotCount: number;
}

/**
 * P18: what a profile session needs of a node. `minChromeMajor`: a node whose pinned Chrome is at
 * least this (0 for sessions without a profile). `warm`: the start restores a saved profile, so
 * the node's warm browsers, not its hot ones, order the choice.
 */
export interface NodeNeeds {
  minChromeMajor: number;
  warm: boolean;
}
const NO_NEEDS: NodeNeeds = { minChromeMajor: 0, warm: false };

/**
 * Lock every node that may take a session (FOR NO KEY UPDATE: a plain FOR UPDATE would conflict with the
 * foreign-key checks of unrelated session writes and deadlock), in id order (so two admissions can never wait on
 * each other), and rank those with room: nodes that last reported a hot browser first (the most first), then
 * the most free capacity (K4). The reports only order the choice; they are never trusted for
 * correctness, because capacity is counted from the sessions table under the lock.
 */
async function rankNodes(
  ctx: Ctx,
  tx: Tx,
  exclude: string[],
  needs: NodeNeeds = NO_NEEDS,
): Promise<Candidate[]> {
  const cutoff = new Date(ctx.clock.now() - TIMINGS.schedulingFreshnessMs);
  const all = await tx.$queryRaw<
    {
      id: string;
      slots_total: number;
      hot_count: number;
      warm_count: number;
      chrome_major: number;
      epoch: number;
    }[]
  >`SELECT id, slots_total, hot_count, warm_count, chrome_major, epoch FROM nodes
    WHERE state = 'active' AND NOT fenced AND last_heartbeat_at >= ${cutoff}
      AND NOT (id = ANY(${exclude}::text[]))
    ORDER BY id FOR NO KEY UPDATE`;
  const nodes = all.filter((n) => n.chrome_major >= needs.minChromeMajor);
  if (nodes.length === 0) {
    // Some node is up, but none runs a Chrome that can open this profile: waiting will not help.
    if (all.length > 0 && needs.minChromeMajor > 0)
      throw new AppError(
        "conflict",
        "No browser node runs a Chrome new enough for this profile.",
        { retryable: false, param: "profile.id" },
      );
    return [];
  }
  const used = await tx.session.groupBy({
    by: ["nodeId"],
    where: {
      nodeId: { in: nodes.map((n) => n.id) },
      status: { in: NON_TERMINAL },
    },
    _count: { _all: true },
  });
  const usedBy = new Map(used.map((u) => [u.nodeId, u._count._all]));
  return nodes
    .map((n) => {
      // A profile restore takes a warm browser; anything else a hot one.
      const ready = needs.warm ? n.warm_count : n.hot_count;
      return {
        id: n.id,
        epoch: n.epoch,
        free: n.slots_total - (usedBy.get(n.id) ?? 0),
        hot: ready > 0,
        hotCount: ready,
      };
    })
    .filter((c) => c.free > 0)
    .sort(
      (a, b) =>
        Number(b.hot) - Number(a.hot) ||
        // Spread over the nodes with warm browsers: the one with more goes first, and since a
        // placement counts one as taken, consecutive starts alternate rather than drain one node.
        b.hotCount - a.hotCount ||
        b.free - a.free ||
        a.id.localeCompare(b.id),
    );
}

/** Thrown to roll an admission back when there is no room; the caller treats it as `full`. */
export class AdmissionFull extends Error {
  constructor() {
    super("no capacity");
  }
}

export type Admission =
  | {
      kind: "ok";
      sessionId: string;
      nodeId: string;
      epoch: number;
      /** P18: the profile the session starts from, with the lock taken if it persists. */
      profile?: AdmittedProfile;
    }
  | { kind: "quota" }
  | { kind: "full" };

/**
 * K3. One transaction: lock the project row, count its live sessions, lock the nodes, check
 * capacity, insert the session. Quota and capacity cannot be oversubscribed by concurrent
 * requests. No session row exists unless a slot is reserved (A11).
 */
export async function admit(
  ctx: Ctx,
  tx: Tx,
  auth: Auth,
  options: SessionOptions,
  linkIdempotencyKey?: string,
): Promise<Admission> {
  const [project] = await tx.$queryRaw<{ max_concurrent_sessions: number }[]>`
    SELECT max_concurrent_sessions FROM projects WHERE id = ${auth.projectId}::uuid FOR NO KEY UPDATE`;
  if (!project) throw new Error("project vanished");
  const live = await tx.session.count({
    where: { projectId: auth.projectId, status: { in: NON_TERMINAL } },
  });
  if (live >= project.max_concurrent_sessions) return { kind: "quota" };

  const now = new Date(ctx.clock.now());
  const id = newUuid();
  // P18: read the profile, and take its write lock if the session persists. A refusal throws,
  // which rolls the whole admission back.
  const profile = options.profile
    ? await admitProfile(ctx, tx, auth, options.profile, id, now)
    : undefined;
  const needs = profile?.needs ?? NO_NEEDS;

  const best = (await rankNodes(ctx, tx, [], needs))[0];
  if (!best) {
    // Returning would commit the profile's lock without a session: roll back instead.
    if (profile) throw new AdmissionFull();
    return { kind: "full" };
  }

  // The node is about to take a hot (or, for a restore, warm) browser, if it had one. Count it as
  // taken now, so the next admission in a burst prefers a node that still has one; the node's next
  // heartbeat (2 s) reports the truth again. The row is locked by rankNodes.
  if (best.hot) {
    if (needs.warm)
      await tx.$executeRaw`UPDATE nodes SET warm_count = GREATEST(warm_count - 1, 0) WHERE id = ${best.id}`;
    else
      await tx.$executeRaw`UPDATE nodes SET hot_count = GREATEST(hot_count - 1, 0) WHERE id = ${best.id}`;
  }

  await tx.session.create({
    data: {
      id,
      projectId: auth.projectId,
      apiKeyId: auth.apiKeyId,
      status: "scheduling",
      options: options as object,
      nodeId: best.id,
      nodeEpoch: best.epoch,
      createdAt: now,
      profileId: profile?.profileUuid ?? null,
    },
  });
  // `requested` is never stored in v1: the row is created already scheduled, with both events.
  await addEvent(tx, id, { type: "session.requested", data: {} }, now);
  await addEvent(
    tx,
    id,
    { type: "session.scheduled", data: { nodeId: NodeId.parse(best.id) } },
    now,
  );
  if (linkIdempotencyKey) {
    await tx.idempotencyKey.update({
      where: { id: linkIdempotencyKey },
      data: { sessionId: id },
    });
  }
  return {
    kind: "ok",
    sessionId: id,
    nodeId: best.id,
    epoch: best.epoch,
    ...(profile ? { profile } : {}),
  };
}

/**
 * K5: after a node refuses, move the session to another node without changing its status.
 * Returns null if no other node has room.
 */
export async function reassign(
  ctx: Ctx,
  tx: Tx,
  sessionId: string,
  excludeNodeIds: string[],
  needs: NodeNeeds = NO_NEEDS,
): Promise<{ nodeId: string; epoch: number } | null> {
  const cur = await tx.session.findUnique({
    where: { id: sessionId },
    select: { status: true, projectId: true },
  });
  if (!cur || cur.status !== "starting") return null;
  let best: Candidate | undefined;
  try {
    best = (await rankNodes(ctx, tx, excludeNodeIds, needs))[0];
  } catch (e) {
    if (e instanceof AppError) return null; // no other node can open the profile
    throw e;
  }
  if (!best) return null;
  const r = await tx.session.updateMany({
    where: { id: sessionId, status: "starting" },
    data: { nodeId: best.id, nodeEpoch: best.epoch },
  });
  if (r.count === 0) return null;
  await addEvent(
    tx,
    sessionId,
    { type: "session.scheduled", data: { nodeId: NodeId.parse(best.id) } },
    new Date(ctx.clock.now()),
  );
  return { nodeId: best.id, epoch: best.epoch };
}
