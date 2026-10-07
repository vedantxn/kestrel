import {
  canTransition,
  terminalStatusFor,
  type EndReason,
  type EventBody,
  type SessionStatus,
} from "@kestrel/contracts";
import { Prisma } from "@kestrel/db";
import type { Ctx } from "./context.js";
import { newUuid } from "./ids.js";

export type Tx = Prisma.TransactionClient;

/** A deadlock or write conflict: Postgres aborted this transaction so the other could proceed. Run it again. */
export function isTransientDbError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034"
  );
}

/** The database itself is unreachable or overloaded, as opposed to this one statement being bad. */
export function isConnectivityError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(e.code)
  )
    return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|Can't reach database|too many clients|timeout/i.test(
    e instanceof Error ? e.message : String(e),
  );
}

/** Every multi-statement change runs through here, so a deadlock is retried rather than surfaced as a 500. */
export async function runTx<T>(
  ctx: Ctx,
  fn: (tx: Tx) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await ctx.db.$transaction(fn);
    } catch (e) {
      if (i >= attempts || !isTransientDbError(e)) throw e;
      await new Promise((r) => setTimeout(r, 5 * i + Math.random() * 10));
    }
  }
}

export const TERMINAL: SessionStatus[] = ["stopped", "failed", "timed_out"];
export const NON_TERMINAL: SessionStatus[] = [
  "requested",
  "scheduling",
  "starting",
  "ready",
  "active",
  "stopping",
];
const BEFORE_STOPPING: SessionStatus[] = [
  "requested",
  "scheduling",
  "starting",
  "ready",
  "active",
];

/** Append an event. A repeated `dedupeKey` (a node report delivered twice) is ignored, not an error. */
export async function addEvent(
  tx: Tx,
  sessionId: string,
  body: EventBody,
  at: Date,
  dedupeKey?: string,
): Promise<boolean> {
  const r = await tx.sessionEvent.createMany({
    data: [
      {
        id: newUuid(),
        sessionId,
        type: body.type,
        data: body.data as object,
        at,
        dedupeKey: dedupeKey ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return r.count === 1;
}

/**
 * K11. Every status change is "set to `to` only if currently one of `from`", and writes its
 * events in the same transaction. Returns false if another actor got there first.
 */
export async function transition(
  tx: Tx,
  args: {
    id: string;
    from: SessionStatus[];
    to: SessionStatus;
    data?: Prisma.SessionUncheckedUpdateManyInput;
    events: EventBody[];
    at: Date;
    onlyIf?: Prisma.SessionWhereInput;
  },
): Promise<boolean> {
  for (const f of args.from) {
    if (!canTransition(f, args.to))
      throw new Error(`illegal session transition ${f} -> ${args.to}`);
  }
  const r = await tx.session.updateMany({
    where: { id: args.id, status: { in: args.from }, ...args.onlyIf },
    data: { ...args.data, status: args.to },
  });
  if (r.count === 0) return false;
  for (const e of args.events) await addEvent(tx, args.id, e, args.at);
  return true;
}

/** Begin ending a session for `reason`. False if it was already stopping or finished. */
export async function beginStop(
  tx: Tx,
  id: string,
  reason: EndReason,
  at: Date,
): Promise<boolean> {
  return transition(tx, {
    id,
    from: BEFORE_STOPPING,
    to: "stopping",
    // The database's enum gains `profile_unavailable` in the profiles migration (P18-2).
    data: {
      endReason: reason as Exclude<EndReason, "profile_unavailable">,
      stoppingAt: at,
      captcha: Prisma.DbNull,
    },
    events: [{ type: "session.stopping", data: { endReason: reason } }],
    at,
  });
}

/**
 * Write the terminal status, once, when the node confirms the container is gone (a `removed`
 * report, or a stop answered "gone"), or when the sweeper declares the node lost (8.1).
 */
export async function completeStop(
  ctx: Ctx,
  tx: Tx,
  id: string,
  at: Date,
  browserSeconds?: number,
  /** G-20: the egress gateway's counts, from the node's `removed` report. */
  egressBytes?: { up: number; down: number },
): Promise<boolean> {
  const row = await tx.session.findUnique({
    where: { id },
    select: { status: true, endReason: true, readyAt: true },
  });
  if (!row || row.status !== "stopping") return false;
  const reason = row.endReason ?? "node_lost";
  const status = terminalStatusFor(reason);
  const seconds =
    browserSeconds ??
    (row.readyAt
      ? Math.max(0, (at.getTime() - row.readyAt.getTime()) / 1000)
      : 0);
  const ok = await transition(tx, {
    id,
    from: ["stopping"],
    to: status,
    data: {
      endedAt: at,
      browserSeconds: seconds,
      ...(egressBytes
        ? {
            egressBytesUp: BigInt(egressBytes.up),
            egressBytesDown: BigInt(egressBytes.down),
          }
        : {}),
    },
    events: [{ type: "session.ended", data: { endReason: reason, status } }],
    at,
  });
  if (ok) ctx.metrics.ended.inc({ status, reason });
  return ok;
}
