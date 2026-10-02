import { createHash } from "node:crypto";
import { TIMINGS } from "@kestrel/contracts";
import { Prisma } from "@kestrel/db";
import type { Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { newUuid } from "./ids.js";

/** Canonical JSON: keys sorted, so equal requests hash equal whatever the order they arrived in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const requestHash = (resolvedOptions: unknown): string =>
  createHash("sha256").update(canonical(resolvedOptions)).digest("hex");

export type Claim =
  { kind: "new"; rowId: string } | { kind: "existing"; sessionId: string };

/**
 * A12. The key is recorded before any waiting. A repeat while the first request is still
 * waiting gets 409 `conflict` (retryable); afterwards it gets the original session. G-11: a
 * repeat with a different request is a `conflict` that says so, not a silent replay.
 * If the first request died, its row stops blocking once `lockedUntil` passes.
 */
export async function claimIdempotencyKey(
  ctx: Ctx,
  projectId: string,
  key: string,
  hash: string,
  waitMs: number,
): Promise<Claim> {
  const now = ctx.clock.now();
  const lockedUntil = new Date(
    now + waitMs + TIMINGS.nodeCallTimeoutMs + 5_000,
  );
  const expiresAt = new Date(now + TIMINGS.idempotencyKeyTtlMs);
  const rowId = newUuid();
  try {
    await ctx.db.idempotencyKey.create({
      data: {
        id: rowId,
        projectId,
        key,
        requestHash: hash,
        lockedUntil,
        expiresAt,
        createdAt: new Date(now),
      },
    });
    return { kind: "new", rowId };
  } catch (e) {
    if (
      !(e instanceof Prisma.PrismaClientKnownRequestError) ||
      e.code !== "P2002"
    )
      throw e;
  }

  const existing = await ctx.db.idempotencyKey.findUnique({
    where: { projectId_key: { projectId, key } },
  });
  if (!existing) return claimIdempotencyKey(ctx, projectId, key, hash, waitMs); // deleted in between: try again
  if (existing.expiresAt.getTime() <= now) {
    await ctx.db.idempotencyKey.deleteMany({
      where: { id: existing.id, expiresAt: { lte: new Date(now) } },
    });
    return claimIdempotencyKey(ctx, projectId, key, hash, waitMs);
  }
  if (existing.requestHash !== hash) {
    throw new AppError(
      "conflict",
      "This idempotencyKey was already used with a different request.",
      {
        param: "idempotencyKey",
        retryable: false,
      },
    );
  }
  if (existing.sessionId)
    return { kind: "existing", sessionId: existing.sessionId };
  if (existing.lockedUntil.getTime() > now) {
    throw new AppError(
      "conflict",
      "A request with this idempotencyKey is still in progress. Retry shortly.",
      {
        param: "idempotencyKey",
      },
    );
  }
  // The first request died before it created a session: take the key over.
  const took = await ctx.db.idempotencyKey.updateMany({
    where: {
      id: existing.id,
      sessionId: null,
      lockedUntil: existing.lockedUntil,
    },
    data: { lockedUntil },
  });
  if (took.count === 0)
    return claimIdempotencyKey(ctx, projectId, key, hash, waitMs);
  return { kind: "new", rowId: existing.id };
}

/** The request failed before any session existed: free the key so the client can retry. */
export async function releaseIdempotencyKey(
  ctx: Ctx,
  rowId: string,
): Promise<void> {
  await ctx.db.idempotencyKey.deleteMany({
    where: { id: rowId, sessionId: null },
  });
}
