import { NodeId, TIMINGS } from "@kestrel/contracts";
import type { Ctx } from "./context.js";
import {
  beginStop,
  completeStop,
  addEvent,
  NON_TERMINAL,
} from "./lifecycle.js";
import { dispatchStop } from "./sessions.js";

/** An arbitrary constant naming the sweeper's advisory lock ("KEST"). */
const SWEEPER_LOCK = 1263424340;

interface StopToSend {
  sessionId: string;
  nodeId: string;
}

/**
 * K9, K8, K10. Every 5 seconds, under a transaction-scoped advisory lock (safe through a
 * connection pool, and it vanishes with the transaction, so a dead leader never holds it):
 *
 *  - ends sessions stuck before ready for 45 seconds. This covers an API process dying
 *    between reserving a slot and calling the node;
 *  - declares a node lost after 15 seconds of silence, fails its sessions, fences its capacity
 *    and gives it a new epoch.
 *
 * Nothing is declared lost until this sweeper has been leader and connected to the database for
 * a full 15 seconds. Without that grace, a database outage or an API restart would see every
 * node as silent and wrongly fail every running session.
 */
export class Sweeper {
  /** When the current unbroken run of successful leader ticks began; null while not connected. */
  private connectedSince: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TIMINGS.sweeperIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** For tests and the internal health endpoint. */
  get connectedForMs(): number | null {
    return this.connectedSince === null
      ? null
      : this.ctx.clock.now() - this.connectedSince;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { ctx } = this;
    const nowMs = ctx.clock.now();
    try {
      await ctx.failpoints.hit("api.sweeper.tick");
      const graceOver =
        this.connectedSince !== null &&
        nowMs - this.connectedSince >= TIMINGS.sweeperGraceMs;
      const outcome = await ctx.db.$transaction(async (tx) => {
        const [lock] = await tx.$queryRaw<
          { ok: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${SWEEPER_LOCK}::bigint) AS ok`;
        if (!lock?.ok) return null;
        const now = new Date(nowMs);
        const toStop: StopToSend[] = [];

        // Sessions that never reached ready.
        const stuck = await tx.session.findMany({
          where: {
            status: { in: ["requested", "scheduling", "starting"] },
            createdAt: { lt: new Date(nowMs - TIMINGS.startTimeoutMs) },
          },
          select: { id: true, nodeId: true },
        });
        for (const s of stuck) {
          if (await beginStop(tx, s.id, "start_timeout", now)) {
            ctx.metrics.sweeper.inc({ action: "start_timeout" });
            if (s.nodeId) toStop.push({ sessionId: s.id, nodeId: s.nodeId });
            else await completeStop(ctx, tx, s.id, now);
          }
        }

        // Lost nodes, only once the grace has passed.
        let lost = 0;
        if (graceOver) {
          const cutoff = new Date(nowMs - TIMINGS.nodeLostAfterMs);
          const silent = await tx.node.findMany({
            where: {
              state: "active",
              OR: [
                { lastHeartbeatAt: { lt: cutoff } },
                { lastHeartbeatAt: null, registeredAt: { lt: cutoff } },
              ],
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          for (const { id } of silent) {
            // Lock, then look again: a heartbeat may have landed since the query.
            const [fresh] = await tx.$queryRaw<
              { last: Date | null; registered: Date }[]
            >`
              SELECT last_heartbeat_at AS last, registered_at AS registered FROM nodes WHERE id = ${id} AND state = 'active' FOR UPDATE`;
            if (!fresh) continue;
            if ((fresh.last ?? fresh.registered).getTime() >= cutoff.getTime())
              continue;
            lost++;
            ctx.metrics.sweeper.inc({ action: "node_lost" });
            await tx.node.update({
              where: { id },
              data: {
                state: "lost",
                fenced: true,
                epoch: { increment: 1 },
                lostAt: now,
              },
            });
            const sessions = await tx.session.findMany({
              where: { nodeId: id, status: { in: NON_TERMINAL } },
              select: { id: true, status: true },
            });
            for (const s of sessions) {
              await addEvent(
                tx,
                s.id,
                { type: "node.lost", data: { nodeId: NodeId.parse(id) } },
                now,
              );
              if (s.status !== "stopping")
                await beginStop(tx, s.id, "node_lost", now);
              await completeStop(ctx, tx, s.id, now);
            }
          }
        }
        return { toStop, lost };
      });

      if (outcome === null) {
        this.connectedSince = null; // not the leader: a later takeover starts its own grace
      } else {
        this.connectedSince ??= nowMs;
        for (const s of outcome.toStop)
          void dispatchStop(ctx, s.sessionId, s.nodeId, "start_timeout");
      }
    } catch (e) {
      // The database is unreachable, or a failpoint threw. Either way, restart the grace.
      this.connectedSince = null;
      ctx.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "sweeper tick failed",
      );
    } finally {
      this.running = false;
    }
  }
}
