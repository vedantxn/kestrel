import {
  TIMINGS,
  sanitizeDeep,
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
  isConnectivityError,
  runTx,
  transition,
  type Tx,
} from "./lifecycle.js";

/** C4's repair path: the node tells the API what it holds, and the API tells it what to do about it. */

/** A fence lifts only after this many consecutive clean heartbeats at the new epoch. */
const CLEAN_HEARTBEATS_TO_UNFENCE = 2;

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
 * the heartbeat never interleave on one node. The lock is FOR NO KEY UPDATE: a plain FOR UPDATE
 * conflicts with the foreign-key checks of every session write on this node and deadlocks.
 */
export async function heartbeat(
  ctx: Ctx,
  req: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  ctx.metrics.heartbeats.inc({ node: req.nodeId });
  const now = new Date(ctx.clock.now());
  return runTx(ctx, async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM nodes WHERE id = ${req.nodeId} FOR NO KEY UPDATE`;
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

    // A node that was declared lost stays fenced until it has adopted its new epoch and has shown,
    // twice running, that it holds nothing the API ended or does not know. One empty heartbeat is
    // not enough: an agent that has just restarted may not have reconciled with Docker yet.
    let { fenced, state, cleanHeartbeats } = node;
    if (node.state === "lost") {
      const clean =
        req.epoch === node.epoch && stop.length === 0 && unknown.length === 0;
      cleanHeartbeats = clean ? node.cleanHeartbeats + 1 : 0;
      if (cleanHeartbeats >= CLEAN_HEARTBEATS_TO_UNFENCE) {
        fenced = false;
        state = "active";
        cleanHeartbeats = 0;
      }
    }
    await tx.node.update({
      where: { id: node.id },
      data: {
        lastHeartbeatAt: now,
        hotCount: req.hotCount,
        slotsTotal: req.slots.total,
        state,
        fenced,
        cleanHeartbeats,
        ...(state === "active" && node.state === "lost"
          ? { lostAt: null }
          : {}),
      },
    });

    const heldIds = [...heldUuids.keys()];
    // Not while the node still has reports to deliver: one of them may be this very session's removal.
    const settled =
      state === "active" &&
      !fenced &&
      req.epoch === node.epoch &&
      req.pendingReports === 0;

    // Sessions the API is stopping on this node that the node no longer holds: absence is
    // confirmation. This repairs a lost stop and a lost start. The age floor keeps a heartbeat
    // taken before the stop was issued from counting.
    const floor = new Date(now.getTime() - 2 * TIMINGS.heartbeatIntervalMs);
    const stuck = await tx.session.findMany({
      where: {
        nodeId: node.id,
        status: "stopping",
        stoppingAt: { lte: floor },
        id: { notIn: heldIds },
      },
      select: { id: true },
    });
    for (const s of stuck) await completeStop(ctx, tx, s.id, now);

    // A session the API believes is running, that the node has stopped holding without saying so
    // (a removal report lost for good, or an agent that restarted with an empty store), would
    // otherwise stay `ready` and keep its slot forever.
    if (settled) {
      const absentFloor = new Date(
        now.getTime() - 3 * TIMINGS.heartbeatIntervalMs,
      );
      const vanished = await tx.session.findMany({
        where: {
          nodeId: node.id,
          status: { in: ["ready", "active"] },
          readyAt: { lte: absentFloor },
          id: { notIn: heldIds },
        },
        select: { id: true },
      });
      for (const s of vanished) {
        await addEvent(
          tx,
          s.id,
          {
            type: "runtime.crashed",
            data: { process: "container", exitCode: null, signal: null },
          },
          now,
        );
        await beginStop(tx, s.id, "runtime_crash", now);
        await completeStop(ctx, tx, s.id, now);
        ctx.metrics.sweeper.inc({ action: "vanished" });
      }
    }

    return {
      epoch: node.epoch,
      fenced,
      stop,
      unknown,
    } satisfies HeartbeatResponse;
  });
}

/**
 * G15. Reports are idempotent: each carries an id, and a repeated delivery changes nothing.
 * They are also independent: one that cannot be applied (hostile or malformed content from a
 * container) is logged and acknowledged rather than blocking every report behind it. A failure
 * of the database itself is different: the batch fails and the node resends it.
 */
export async function ingestReports(
  ctx: Ctx,
  req: ReportsRequest,
): Promise<ReportsResponse> {
  const acked: string[] = [];
  for (const report of req.reports) {
    try {
      await runTx(ctx, (tx) => applyReport(ctx, tx, req.nodeId, report));
    } catch (e) {
      if (isConnectivityError(e)) throw e;
      ctx.log.error(
        {
          node: req.nodeId,
          report: report.id,
          kind: report.kind,
          err: e instanceof Error ? e.message : String(e),
        },
        "dropping a report that cannot be applied",
      );
      ctx.metrics.sweeper.inc({ action: "report_dropped" });
    }
    acked.push(report.id);
  }
  return { acked };
}

async function applyReport(
  ctx: Ctx,
  tx: Tx,
  nodeId: string,
  r: Report,
): Promise<void> {
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
    const fresh = await addEvent(tx, uuid, sanitizeDeep(r.event), at, dedupe);
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
    }
    // runtime.crashed is recorded; the matching `removed` report ends the session.
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
