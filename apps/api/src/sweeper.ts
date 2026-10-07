import { NodeId, TIMINGS, type EndReason } from "@kestrel/contracts";
import type { Ctx } from "./context.js";
import {
  beginStop,
  completeStop,
  addEvent,
  runTx,
  NON_TERMINAL,
} from "./lifecycle.js";
import { collectProfiles, releaseProfileLock } from "./profile-sessions.js";
import { dispatchStop } from "./sessions.js";

/** P18: superseded versions and orphaned blobs are collected this often, by the leader. */
const PROFILE_COLLECT_MS = 60_000;

/** An arbitrary constant naming the sweeper's advisory lock ("KEST"). */
const SWEEPER_LOCK = 1263424340;

interface StopToSend {
  sessionId: string;
  nodeId: string;
  reason: EndReason;
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
  /** When the current unbroken run of successful leader ticks began, on the monotonic clock; null while not connected. */
  private connectedSince: number | null = null;
  /** The previous tick, on both clocks, to notice a pause or a clock step. */
  private lastTick: { wall: number; mono: number } | null = null;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private collectTimer: NodeJS.Timeout | undefined;
  /** The collection in progress, if any: a second never starts beside it. */
  private collecting: Promise<void> | null = null;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TIMINGS.sweeperIntervalMs);
    this.timer.unref();
    // P18: profile collection runs on its own timer, never inside a tick: a slow store or many
    // blobs must not delay ending stuck starts or declaring a node lost.
    if (this.ctx.profiles) {
      this.collectTimer = setInterval(
        () => void this.collect(),
        PROFILE_COLLECT_MS,
      );
      this.collectTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.collectTimer) clearInterval(this.collectTimer);
  }

  /** For tests and the internal health endpoint. */
  get connectedForMs(): number | null {
    return this.connectedSince === null
      ? null
      : this.ctx.monotonic() - this.connectedSince;
  }

  /** P18: profile collection, on its own; a store failure never fails the tick. */
  collect(nowMs: number = this.ctx.clock.now()): Promise<void> {
    this.collecting ??= collectProfiles(this.ctx, nowMs)
      .catch((e: unknown) => {
        this.ctx.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "profile collection failed",
        );
      })
      .finally(() => (this.collecting = null));
    return this.collecting;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { ctx } = this;
    const nowMs = ctx.clock.now();
    const mono = ctx.monotonic();
    try {
      await ctx.failpoints.hit("api.sweeper.tick");
      // The grace exists so a stall of the API's own can never look like every node falling silent.
      // A tick that comes much later than it should (the host or process was paused), or after the
      // wall clock stepped, is exactly that: the node heartbeats we should have received may still
      // be queued. Start the grace again, and measure it on a clock that cannot step.
      if (this.lastTick) {
        const monoGap = mono - this.lastTick.mono;
        const wallGap = nowMs - this.lastTick.wall;
        if (
          monoGap > 3 * TIMINGS.sweeperIntervalMs ||
          Math.abs(wallGap - monoGap) > TIMINGS.sweeperIntervalMs
        ) {
          ctx.log.warn(
            { monoGap, wallGap },
            "the sweeper was paused or the clock stepped; restarting its grace period",
          );
          this.connectedSince = null;
        }
      }
      this.lastTick = { wall: nowMs, mono };
      const graceOver =
        this.connectedSince !== null &&
        mono - this.connectedSince >= TIMINGS.sweeperGraceMs;
      const outcome = await runTx(ctx, async (tx) => {
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
          select: { id: true },
        });
        for (const s of stuck) {
          if (await beginStop(tx, s.id, "start_timeout", now)) {
            ctx.metrics.sweeper.inc({ action: "start_timeout" });
            // Read the node after winning the stop: a refusal may have moved the session to another node.
            const row = await tx.session.findUnique({
              where: { id: s.id },
              select: { nodeId: true },
            });
            if (row?.nodeId)
              toStop.push({
                sessionId: s.id,
                nodeId: row.nodeId,
                reason: "start_timeout",
              });
            else await completeStop(ctx, tx, s.id, now);
          }
        }

        // A backstop on lifetime. The node enforces `timeout` (G11), but a session whose node has
        // gone quiet about it must not outlive its limit on the API's side either.
        const graceMs = 60_000;
        const overdue = await tx.$queryRaw<
          { id: string; node_id: string | null }[]
        >`
          SELECT id, node_id FROM sessions
          WHERE status IN ('ready', 'active') AND ready_at IS NOT NULL
            AND ready_at + ((options->>'timeout')::bigint * interval '1 millisecond') < ${new Date(nowMs - graceMs)}`;
        for (const s of overdue) {
          if (await beginStop(tx, s.id, "max_lifetime", now)) {
            ctx.metrics.sweeper.inc({ action: "max_lifetime" });
            if (s.node_id)
              toStop.push({
                sessionId: s.id,
                nodeId: s.node_id,
                reason: "max_lifetime",
              });
            else await completeStop(ctx, tx, s.id, now);
          }
        }

        // Idempotency keys are kept 24 hours (A12) and then forgotten.
        await tx.idempotencyKey.deleteMany({
          where: { expiresAt: { lt: now } },
        });

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
              SELECT last_heartbeat_at AS last, registered_at AS registered FROM nodes WHERE id = ${id} AND state = 'active' FOR NO KEY UPDATE`;
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
              // P18: a writer on a lost node can never report its save, whatever it was doing,
              // including one already stopping for another reason (section 5, rule 2).
              await releaseProfileLock(tx, s.id, "node_lost", now);
              await completeStop(ctx, tx, s.id, now);
            }
          }
        }
        return { toStop, lost };
      });

      if (outcome === null) {
        this.connectedSince = null; // not the leader: a later takeover starts its own grace
      } else {
        this.connectedSince ??= mono;
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
