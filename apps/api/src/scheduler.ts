import { NodeId, TIMINGS, type SessionOptions } from "@kestrel/contracts";
import type { Ctx, Auth } from "./context.js";
import { NON_TERMINAL, addEvent, type Tx } from "./lifecycle.js";
import { newUuid } from "./ids.js";

/**
 * K2. A node's free capacity is its slots minus its sessions not yet confirmed removed.
 * Pool containers are invisible here: the node keeps its pool within what sessions leave free (G4-G6).
 */
interface Candidate {
  id: string;
  epoch: number;
  free: number;
  hot: boolean;
}

/**
 * Lock every node that may take a session (FOR NO KEY UPDATE: a plain FOR UPDATE would conflict with the
 * foreign-key checks of unrelated session writes and deadlock), in id order (so two admissions can never wait on
 * each other), and rank those with room: nodes that last reported a hot browser first, then
 * the most free capacity (K4). The reports only order the choice; they are never trusted for
 * correctness, because capacity is counted from the sessions table under the lock.
 */
async function rankNodes(
  ctx: Ctx,
  tx: Tx,
  exclude: string[],
): Promise<Candidate[]> {
  const cutoff = new Date(ctx.clock.now() - TIMINGS.schedulingFreshnessMs);
  const nodes = await tx.$queryRaw<
    { id: string; slots_total: number; hot_count: number; epoch: number }[]
  >`SELECT id, slots_total, hot_count, epoch FROM nodes
    WHERE state = 'active' AND NOT fenced AND last_heartbeat_at >= ${cutoff}
      AND NOT (id = ANY(${exclude}::text[]))
    ORDER BY id FOR NO KEY UPDATE`;
  if (nodes.length === 0) return [];
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
    .map((n) => ({
      id: n.id,
      epoch: n.epoch,
      free: n.slots_total - (usedBy.get(n.id) ?? 0),
      hot: n.hot_count > 0,
    }))
    .filter((c) => c.free > 0)
    .sort(
      (a, b) =>
        Number(b.hot) - Number(a.hot) ||
        b.free - a.free ||
        a.id.localeCompare(b.id),
    );
}

export type Admission =
  | { kind: "ok"; sessionId: string; nodeId: string; epoch: number }
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

  const best = (await rankNodes(ctx, tx, []))[0];
  if (!best) return { kind: "full" };

  // The node is about to take a hot browser, if it had one. Count it as taken now, so the next
  // admission in a burst prefers a node that still has one; the node's next heartbeat (2 s)
  // reports the truth again. The row is locked by rankNodes.
  if (best.hot)
    await tx.$executeRaw`UPDATE nodes SET hot_count = GREATEST(hot_count - 1, 0) WHERE id = ${best.id}`;

  const now = new Date(ctx.clock.now());
  const id = newUuid();
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
  return { kind: "ok", sessionId: id, nodeId: best.id, epoch: best.epoch };
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
): Promise<{ nodeId: string; epoch: number } | null> {
  const cur = await tx.session.findUnique({
    where: { id: sessionId },
    select: { status: true, projectId: true },
  });
  if (!cur || cur.status !== "starting") return null;
  const best = (await rankNodes(ctx, tx, excludeNodeIds))[0];
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
