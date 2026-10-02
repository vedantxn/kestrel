import {
  TIMINGS,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type RegisterRequest,
  type RegisterResponse,
  type Report,
  type ReportsRequest,
  type ReportsResponse,
} from "@kestrel/contracts";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { publicSessionId, sessionUuid } from "./ids.js";
import {
  NON_TERMINAL,
  TERMINAL,
  addEvent,
  beginStop,
  completeStop,
  transition,
} from "./lifecycle.js";

/** C4's repair path: the node tells the API what it holds, and the API tells it what to do about it. */

export async function registerNode(
  ctx: Ctx,
  req: RegisterRequest,
): Promise<RegisterResponse> {
  const now = new Date(ctx.clock.now());
  const node = await ctx.db.node.upsert({
    where: { id: req.nodeId },
    create: {
      id: req.nodeId,
      address: req.address,
      slotsTotal: req.slotsTotal,
      runtimeVersion: req.runtimeVersion,
      registeredAt: now,
      lastHeartbeatAt: now,
    },
    // An agent restart keeps its epoch (K10); only being declared lost changes it.
    update: {
      address: req.address,
      slotsTotal: req.slotsTotal,
      runtimeVersion: req.runtimeVersion,
      lastHeartbeatAt: now,
    },
  });
  return { epoch: node.epoch };
}

/**
 * K7 and K10. One transaction per heartbeat, under a lock on the node row so the sweeper and
 * the heartbeat never interleave on one node.
 */
export async function heartbeat(
  ctx: Ctx,
  req: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  ctx.metrics.heartbeats.inc({ node: req.nodeId });
  const now = new Date(ctx.clock.now());
  const response = await ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM nodes WHERE id = ${req.nodeId} FOR UPDATE`;
    if (locked.length === 0)
      throw new AppError(
        "not_found",
        "Node is not registered; register first.",
      );
    const node = await tx.node.findUniqueOrThrow({ where: { id: req.nodeId } });

    // What the node holds, against what the API believes.
    const heldUuids = new Map<string, string>();
    const unknown: HeartbeatResponse["unknown"] = [];
    for (const s of req.sessions) {
      const uuid = sessionUuid(s.sessionId);
      if (uuid) heldUuids.set(uuid, s.state);
    }
    const rows = heldUuids.size
      ? await tx.session.findMany({
          where: { id: { in: [...heldUuids.keys()] } },
          select: { id: true, status: true, endReason: true, nodeId: true },
        })
      : [];
    const known = new Map(rows.map((r) => [r.id, r]));
    const stop: HeartbeatResponse["stop"] = [];
    for (const uuid of heldUuids.keys()) {
      const row = known.get(uuid);
      if (!row) {
        unknown.push(publicSessionId(uuid));
      } else if (row.status === "stopping" || TERMINAL.includes(row.status)) {
        // The API ended it; the node still holds it. A session the API ended while the node was away
        // is the one case that keeps a returning node fenced (K10).
        stop.push({
          sessionId: publicSessionId(uuid),
          reason: row.endReason ?? "node_lost",
        });
      }
    }

    // A node that was declared lost stays fenced until it has adopted its new epoch and holds
    // nothing the API ended or does not know.
    let { fenced, state } = node;
    if (
      node.state === "lost" &&
      req.epoch === node.epoch &&
      stop.length === 0 &&
      unknown.length === 0
    ) {
      fenced = false;
      state = "active";
    }
    await tx.node.update({
      where: { id: node.id },
      data: {
        lastHeartbeatAt: now,
        hotCount: req.hotCount,
        slotsTotal: req.slots.total,
        state,
        fenced,
        ...(state === "active" && node.state === "lost"
          ? { lostAt: null }
          : {}),
      },
    });

    // Sessions the API is stopping on this node that the node no longer holds: absence is
    // confirmation. This repairs a lost stop and a lost start. The age floor keeps a heartbeat
    // taken before the stop was issued from counting.
    const floor = new Date(now.getTime() - 2 * TIMINGS.heartbeatIntervalMs);
    const stuck = await tx.session.findMany({
      where: {
        nodeId: node.id,
        status: "stopping",
        stoppingAt: { lte: floor },
        id: { notIn: [...heldUuids.keys()] },
      },
      select: { id: true },
    });
    for (const s of stuck) await completeStop(ctx, tx, s.id, now);

    return {
      epoch: node.epoch,
      fenced,
      stop,
      unknown,
    } satisfies HeartbeatResponse;
  });
  return response;
}

/** G15. Reports are idempotent: each carries an id, and a repeated delivery changes nothing. */
export async function ingestReports(
  ctx: Ctx,
  req: ReportsRequest,
): Promise<ReportsResponse> {
  const acked: string[] = [];
  for (const report of req.reports) {
    await ctx.db.$transaction((tx) => applyReport(ctx, tx, req.nodeId, report));
    acked.push(report.id);
  }
  return { acked };
}

async function applyReport(
  ctx: Ctx,
  tx: Parameters<Parameters<Ctx["db"]["$transaction"]>[0]>[0],
  nodeId: string,
  r: Report,
) {
  const uuid = sessionUuid(r.sessionId);
  if (!uuid) return;
  const session = await tx.session.findUnique({
    where: { id: uuid },
    select: { status: true, nodeId: true },
  });
  if (!session || session.nodeId !== nodeId) return; // not ours to change; acked so the node stops resending
  const at = new Date(r.at);
  const dedupe = `${nodeId}:${r.id}`;

  if (r.kind === "event") {
    const fresh = await addEvent(tx, uuid, r.event, at, dedupe);
    if (!fresh) return;
    // Attachments drive ready <-> active.
    if (r.event.type === "session.attached") {
      await transition(tx, {
        id: uuid,
        from: ["ready"],
        to: "active",
        events: [],
        at,
      });
    } else if (
      r.event.type === "session.detached" &&
      r.event.data.connections === 0
    ) {
      await transition(tx, {
        id: uuid,
        from: ["active"],
        to: "ready",
        events: [],
        at,
      });
    } else if (r.event.type === "runtime.crashed") {
      // Recorded; the matching `removed` report ends the session.
    }
    return;
  }

  // removed: the container is gone and the slot released. Idempotent without a dedupe key:
  // once the session is terminal, neither call below matches anything.
  if (NON_TERMINAL.includes(session.status) && session.status !== "stopping") {
    // The node ended it on its own (deadline, crash, OOM): record why, then finish.
    await beginStop(tx, uuid, r.endReason ?? "runtime_crash", at);
  }
  await completeStop(ctx, tx, uuid, at, r.browserSeconds);
}
