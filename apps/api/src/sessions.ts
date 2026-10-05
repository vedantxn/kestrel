import {
  LIMITS,
  NodeId,
  SessionOptions,
  TIMINGS,
  COMPUTER_LIMITS,
  TOKEN_TTL,
  buildConnectUrl,
  buildLiveViewUrl,
  uuidToId,
  type MintTokenRequest,
  type SessionToken,
  type ComputerRequest,
  type ComputerResponse,
  type CreateSessionRequest,
  type EndReason,
  type ListEventsResponse,
  type ListSessionsResponse,
  type Session,
  type SessionEvent,
  type SessionStatus,
  type StartRequest,
} from "@kestrel/contracts";
import type { Prisma } from "@kestrel/db";
import { type Session as SessionRow } from "@kestrel/db";
import { randomBytes } from "node:crypto";
import { FailpointError, sleep } from "@kestrel/shared";
import type { Auth, Ctx } from "./context.js";
import { AppError } from "./errors.js";
import { publicEventId, publicSessionId, sessionUuid } from "./ids.js";
import {
  claimIdempotencyKey,
  releaseIdempotencyKey,
  requestHash,
} from "./idempotency.js";
import {
  NON_TERMINAL,
  TERMINAL,
  runTx,
  beginStop,
  completeStop,
  transition,
} from "./lifecycle.js";
import { NodeCallError } from "./node-client.js";
import { admit, reassign } from "./scheduler.js";

const MAX_CONCURRENT_WAITERS = 200; // G-13: waiting creates hold a request open each
/** One project must not be able to use up every waiting place. */
const MAX_WAITERS_PER_PROJECT = 50;

// --- Serialization ----------------------------------------------------------------------

/** The API's view of a row (A7). A connectable session carries a fresh token in its `connectUrl`. */
export async function toApiSession(
  ctx: Ctx,
  row: SessionRow,
): Promise<Session> {
  const options = SessionOptions.parse(row.options);
  let connectUrl: string | null = null;
  const node = row.nodeId ? ctx.nodes.get(row.nodeId) : undefined;
  if (
    (row.status === "ready" || row.status === "active") &&
    node &&
    row.readyAt &&
    row.nodeId
  ) {
    const id = publicSessionId(row.id);
    const token = await ctx.signer.mint({
      sessionId: id,
      projectId: uuidToId("prj", row.projectId),
      nodeId: row.nodeId,
      scope: "cdp",
      deadlineMs: row.readyAt.getTime() + options.timeout,
      nowMs: ctx.clock.now(),
    });
    connectUrl = buildConnectUrl(
      ctx.publicHostname,
      node.connectPort,
      id,
      token,
    );
  }
  return {
    id: publicSessionId(row.id),
    status: row.status,
    endReason: row.endReason,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    connectUrl,
    viewport: options.viewport,
    deviceScaleFactor: row.deviceScaleFactor,
    options,
    nodeId: row.nodeId ? NodeId.parse(row.nodeId) : null,
    startPath:
      row.startPath === "hot" || row.startPath === "cold"
        ? row.startPath
        : null,
    usage: { browserSeconds: row.browserSeconds },
  };
}

// --- Create -----------------------------------------------------------------------------

export async function createSession(
  ctx: Ctx,
  auth: Auth,
  body: CreateSessionRequest,
): Promise<{ session: Session; created: boolean }> {
  const t0 = performance.now();
  const project = await ctx.db.project.findUnique({
    where: { id: auth.projectId },
  });
  if (!project) throw new AppError("unauthorized", "Unknown project");

  const retryAfter = ctx.rateLimiter.check(
    auth.projectId,
    project.createsPerMinute,
  );
  if (retryAfter > 0) {
    ctx.metrics.created.inc({ outcome: "rate_limited" });
    throw new AppError(
      "quota_exceeded",
      `Too many sessions created; the limit is ${project.createsPerMinute} per minute.`,
      {
        retryAfterSeconds: retryAfter,
      },
    );
  }

  // Temporary until the egress gateway and node agent chain upstream proxies.
  if (body.proxy)
    throw new AppError("invalid_request", "proxy is not available yet.", {
      param: "proxy",
    });
  const { idempotencyKey, waitForCapacityMs = 0, ...rest } = body;
  const options = SessionOptions.parse(rest);

  let idemRow: string | undefined;
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(
      ctx,
      auth.projectId,
      idempotencyKey,
      requestHash(options),
      waitForCapacityMs,
    );
    if (claim.kind === "existing") {
      const row = await ctx.db.session.findUnique({
        where: { id: claim.sessionId },
      });
      if (row) return { session: await toApiSession(ctx, row), created: false };
      throw new AppError(
        "internal",
        "The session for this idempotencyKey no longer exists.",
      );
    }
    idemRow = claim.rowId;
  }

  const release = async (): Promise<void> => {
    if (idemRow) await releaseIdempotencyKey(ctx, idemRow);
  };

  // Admission: no session row exists until a slot is reserved (A11).
  let reservation: { sessionId: string; nodeId: string; epoch: number };
  const waitUntil =
    performance.now() +
    Math.min(waitForCapacityMs, LIMITS.maxWaitForCapacityMs);
  let waiting = false;
  try {
    for (;;) {
      const r = await runTx(ctx, (tx) =>
        admit(ctx, tx, auth, options, idemRow),
      );
      if (r.kind === "ok") {
        reservation = r;
        break;
      }
      if (r.kind === "quota") {
        ctx.metrics.created.inc({ outcome: "quota" });
        throw new AppError(
          "quota_exceeded",
          `The project is at its limit of ${project.maxConcurrentSessions} concurrent sessions.`,
          {
            retryAfterSeconds: 1,
          },
        );
      }
      const remaining = waitUntil - performance.now();
      if (remaining <= 0) {
        ctx.metrics.created.inc({ outcome: "capacity" });
        throw new AppError(
          "capacity_exhausted",
          "No browser capacity is available right now.",
          { retryAfterSeconds: 1 },
        );
      }
      if (!waiting) {
        const mine = ctx.state.waitersByProject.get(auth.projectId) ?? 0;
        if (
          ctx.state.waiters >= MAX_CONCURRENT_WAITERS ||
          mine >= MAX_WAITERS_PER_PROJECT
        ) {
          throw new AppError(
            "capacity_exhausted",
            "No browser capacity is available and too many requests are waiting.",
            {
              retryAfterSeconds: 1,
            },
          );
        }
        ctx.state.waiters++;
        ctx.state.waitersByProject.set(auth.projectId, mine + 1);
        waiting = true;
      }
      // Retry every 250 ms, with a last attempt exactly at the deadline.
      await sleep(Math.min(TIMINGS.admissionRetryMs, remaining));
    }
  } catch (e) {
    await release();
    throw e;
  } finally {
    if (waiting) {
      ctx.state.waiters--;
      const left = (ctx.state.waitersByProject.get(auth.projectId) ?? 1) - 1;
      if (left <= 0) ctx.state.waitersByProject.delete(auth.projectId);
      else ctx.state.waitersByProject.set(auth.projectId, left);
    }
  }

  await ctx.failpoints.hit("api.create.after_reserve");
  const session = await startOnNode(ctx, auth, reservation, options, t0);
  return { session, created: true };
}

/** Which node a failed start leaves behind a stop for. */
async function failStart(
  ctx: Ctx,
  sessionId: string,
  reason: EndReason,
  error: AppError,
  attemptedNodeId: string,
): Promise<never> {
  const won = await runTx(ctx, async (tx) => {
    if (!(await beginStop(tx, sessionId, reason, new Date(ctx.clock.now()))))
      return null;
    // The error below says "retryable", so a retry with the same idempotency key must make a new
    // session, not be handed this failed one back.
    await tx.idempotencyKey.deleteMany({ where: { sessionId } });
    // Read the node after winning the stop: a refusal may have moved the session to another node.
    const cur = await tx.session.findUnique({
      where: { id: sessionId },
      select: { nodeId: true },
    });
    return { nodeId: cur?.nodeId ?? attemptedNodeId };
  });
  ctx.metrics.created.inc({ outcome: reason });
  if (won) void dispatchStop(ctx, sessionId, won.nodeId, reason);
  throw error;
}

async function startOnNode(
  ctx: Ctx,
  auth: Auth,
  reservation: { sessionId: string; nodeId: string; epoch: number },
  options: SessionOptions,
  t0: number,
): Promise<Session> {
  const { sessionId } = reservation;
  let { nodeId, epoch } = reservation;
  let retried = false;

  const moved = await runTx(ctx, (tx) =>
    transition(tx, {
      id: sessionId,
      from: ["scheduling"],
      to: "starting",
      events: [{ type: "session.starting", data: {} }],
      at: new Date(ctx.clock.now()),
    }),
  );
  if (!moved)
    throw new AppError(
      "conflict",
      "The session was stopped before it started.",
    );

  for (;;) {
    const req: StartRequest = {
      sessionId: publicSessionId(sessionId),
      projectId: uuidToId("prj", auth.projectId) as StartRequest["projectId"],
      epoch,
      viewport: options.viewport,
      network: options.network,
      timeoutMs: options.timeout,
      idleTimeoutMs: options.idleTimeout,
      stopOnDisconnect: options.stopOnDisconnect,
      recording: options.recording,
    };

    let result;
    try {
      // A dropped start message (a failpoint) is indistinguishable from a lost one: the call times out.
      if ((await ctx.failpoints.hit("api.node_start")) === "drop") {
        await sleep(ctx.nodeCallTimeoutMs);
        throw new NodeCallError("start message dropped", "timeout");
      }
      result = await ctx.nodeClient.start(nodeId, req, ctx.nodeCallTimeoutMs);
    } catch (e) {
      if (e instanceof FailpointError) throw e;
      const timedOut = e instanceof NodeCallError && e.kind === "timeout";
      return failStart(
        ctx,
        sessionId,
        timedOut ? "start_timeout" : "node_refused",
        new AppError(
          "internal",
          timedOut
            ? "The browser did not start in time."
            : "The browser node could not be reached.",
          {
            retryable: true,
          },
        ),
        nodeId,
      );
    }

    if (result.result === "ready") {
      await ctx.failpoints.hit("api.create.before_ready");
      const now = new Date(ctx.clock.now());
      const ok = await runTx(ctx, (tx) =>
        transition(tx, {
          id: sessionId,
          from: ["starting"],
          to: "ready",
          data: {
            readyAt: now,
            startPath: result.startPath,
            deviceScaleFactor: result.deviceScaleFactor,
          },
          events: [
            {
              type: "session.ready",
              data: { startPath: result.startPath, readyMs: result.readyMs },
            },
          ],
          at: now,
        }),
      );
      if (!ok) {
        // Stopped, or swept as stuck, while the node was starting it. The stop already sent covers the node.
        const row = await ctx.db.session.findUnique({
          where: { id: sessionId },
        });
        throw new AppError(
          "conflict",
          `The session ended while it was starting (${row?.endReason ?? "unknown"}).`,
          {
            retryable: true,
          },
        );
      }
      ctx.metrics.created.inc({ outcome: "ok" });
      ctx.metrics.create.observe(
        { path: result.startPath },
        (performance.now() - t0) / 1000,
      );
      const row = await ctx.db.session.findUniqueOrThrow({
        where: { id: sessionId },
      });
      return toApiSession(ctx, row);
    }

    if (result.result === "refused" && !retried) {
      // K5: a refusal is retried once, on another node.
      retried = true;
      const other = await runTx(ctx, (tx) =>
        reassign(ctx, tx, sessionId, [nodeId]),
      );
      if (other) {
        nodeId = other.nodeId;
        epoch = other.epoch;
        continue;
      }
    }

    return failStart(
      ctx,
      sessionId,
      result.result === "refused" ? "node_refused" : "runtime_crash",
      result.result === "refused"
        ? new AppError(
            "capacity_exhausted",
            "No browser node could take the session.",
            { retryAfterSeconds: 1 },
          )
        : new AppError("internal", "The browser failed to start.", {
            retryable: true,
          }),
      nodeId,
    );
  }
}

// --- Stop -------------------------------------------------------------------------------

/**
 * Tell the node to stop a session. Best effort: a lost call is repaired by heartbeat
 * reconciliation within seconds (K7). An answer of "gone" means the node holds nothing for
 * it, which counts as confirmation (G14), so the terminal status is written now.
 */
export async function dispatchStop(
  ctx: Ctx,
  sessionId: string,
  nodeId: string,
  reason: EndReason,
): Promise<void> {
  try {
    if ((await ctx.failpoints.hit("api.node_stop")) === "drop") return;
    const res = await ctx.nodeClient.stop(
      nodeId,
      { sessionId: publicSessionId(sessionId), reason },
      ctx.nodeCallTimeoutMs,
    );
    if (res.result === "gone") {
      await runTx(ctx, (tx) =>
        completeStop(ctx, tx, sessionId, new Date(ctx.clock.now())),
      );
    }
  } catch (e) {
    ctx.log.warn(
      { sessionId, nodeId, err: e instanceof Error ? e.message : String(e) },
      "stop call failed; heartbeat will repair",
    );
  }
}

export async function stopSession(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<Session> {
  const uuid = sessionUuid(id);
  const row = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
      })
    : null;
  if (!row) throw new AppError("not_found", "No such session.");

  const won = await runTx(ctx, async (tx) => {
    if (
      !(await beginStop(tx, row.id, "client_stop", new Date(ctx.clock.now())))
    )
      return null;
    // Tell the node the session is on now: a refused start may have moved it since `row` was read.
    const cur = await tx.session.findUnique({
      where: { id: row.id },
      select: { nodeId: true },
    });
    return { nodeId: cur?.nodeId ?? null };
  });
  if (won) {
    if (won.nodeId) void dispatchStop(ctx, row.id, won.nodeId, "client_stop");
    else
      await runTx(ctx, (tx) =>
        completeStop(ctx, tx, row.id, new Date(ctx.clock.now())),
      );
  }
  const fresh = await ctx.db.session.findUniqueOrThrow({
    where: { id: row.id },
  });
  return toApiSession(ctx, fresh);
}

// --- Read -------------------------------------------------------------------------------

export async function getSession(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<Session> {
  const uuid = sessionUuid(id);
  const row = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
      })
    : null;
  if (!row) throw new AppError("not_found", "No such session.");
  return toApiSession(ctx, row);
}

/**
 * W1. A token for one session: `cdp` re-issues the connect URL; `view` and `control` open live
 * view, for a shorter time the caller may choose. Only a running session gets one.
 */
export async function mintSessionToken(
  ctx: Ctx,
  auth: Auth,
  id: string,
  req: MintTokenRequest,
): Promise<SessionToken> {
  const uuid = sessionUuid(id);
  const row = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
      })
    : null;
  if (!row) throw new AppError("not_found", "No such session.");
  const node = row.nodeId ? ctx.nodes.get(row.nodeId) : undefined;
  if (
    (row.status !== "ready" && row.status !== "active") ||
    !node ||
    !row.readyAt ||
    !row.nodeId
  )
    throw new AppError("conflict", "The session is not running.", {
      retryable: false,
    });
  const options = SessionOptions.parse(row.options);
  const publicId = publicSessionId(row.id);
  const live = req.scope !== "cdp";
  let ttlMs = live ? (req.ttlMs ?? TOKEN_TTL.liveDefaultMs) : req.ttlMs;
  if (req.singleUse)
    ttlMs = Math.min(
      ttlMs ?? TOKEN_TTL.singleUseMaxMs,
      TOKEN_TTL.singleUseMaxMs,
    );
  const { token, expMs } = await ctx.signer.mintWithExpiry({
    sessionId: publicId,
    projectId: uuidToId("prj", row.projectId),
    nodeId: row.nodeId,
    scope: req.scope,
    deadlineMs: row.readyAt.getTime() + options.timeout,
    nowMs: ctx.clock.now(),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(req.singleUse ? { jti: randomBytes(16).toString("hex") } : {}),
  });
  return {
    scope: req.scope,
    token,
    url: live
      ? buildLiveViewUrl(ctx.publicHostname, node.connectPort, publicId, token)
      : buildConnectUrl(ctx.publicHostname, node.connectPort, publicId, token),
    expiresAt: new Date(expMs).toISOString(),
  };
}

/**
 * W3. A session's recording, from the node it ran on. Available while it runs and after it
 * ends, until the node's retention removes it; gone if the node is.
 */
export async function sessionRecording(
  ctx: Ctx,
  auth: Auth,
  id: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const uuid = sessionUuid(id);
  const row = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
        select: { id: true, nodeId: true, options: true },
      })
    : null;
  if (!row) throw new AppError("not_found", "No such session.");
  if (!row.nodeId || !SessionOptions.parse(row.options).recording)
    throw new AppError("not_found", "This session was not recorded.");
  let r;
  try {
    r = await ctx.nodeClient.recording(
      row.nodeId,
      publicSessionId(row.id),
      10_000,
    );
  } catch {
    throw new AppError("internal", "The session's node did not answer.");
  }
  if (!r)
    throw new AppError(
      "not_found",
      "No recording is available for this session (the node could not record, or it has been removed).",
    );
  return r;
}

/** W4. One `/computer` action on a running session, through its node agent. */
export async function sessionComputer(
  ctx: Ctx,
  auth: Auth,
  id: string,
  action: ComputerRequest,
): Promise<ComputerResponse> {
  const uuid = sessionUuid(id);
  const row = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
        select: { id: true, status: true, nodeId: true },
      })
    : null;
  if (!row) throw new AppError("not_found", "No such session.");
  if ((row.status !== "ready" && row.status !== "active") || !row.nodeId)
    throw new AppError("conflict", "The session is not running.", {
      retryable: false,
    });
  let r;
  try {
    r = await ctx.nodeClient.computer(
      row.nodeId,
      publicSessionId(row.id),
      action,
      COMPUTER_LIMITS.actionTimeoutMs + 5_000,
    );
  } catch {
    throw new AppError("internal", "The session's node did not answer.");
  }
  if (r.ok) return r.response;
  if (r.status === 404 || r.status === 409)
    throw new AppError("conflict", "The session is not running.", {
      retryable: false,
    });
  throw new AppError("internal", r.error);
}

function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(parts.join("|")).toString("base64url");
}
function decodeCursor(c: string): string[] {
  try {
    return Buffer.from(c, "base64url").toString().split("|");
  } catch {
    throw new AppError("invalid_request", "Malformed cursor.", {
      param: "cursor",
    });
  }
}

export async function listSessions(
  ctx: Ctx,
  auth: Auth,
  q: {
    status?: SessionStatus | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<ListSessionsResponse> {
  const where: Prisma.SessionWhereInput = { projectId: auth.projectId };
  if (q.status) where.status = q.status;
  if (q.cursor) {
    const [ms, id] = decodeCursor(q.cursor);
    const t = Number(ms);
    if (
      !Number.isInteger(t) ||
      t < 0 ||
      t > 8.64e15 ||
      !id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ) {
      throw new AppError("invalid_request", "Malformed cursor.", {
        param: "cursor",
      });
    }
    where.OR = [
      { createdAt: { lt: new Date(t) } },
      { createdAt: new Date(t), id: { lt: id } },
    ];
  }
  const rows = await ctx.db.session.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await Promise.all(page.map((r) => toApiSession(ctx, r))),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor([last.createdAt.getTime(), last.id])
        : null,
  };
}

export async function listEvents(
  ctx: Ctx,
  auth: Auth,
  id: string,
  q: { limit: number; cursor?: string | undefined },
): Promise<ListEventsResponse> {
  const uuid = sessionUuid(id);
  const session = uuid
    ? await ctx.db.session.findFirst({
        where: { id: uuid, projectId: auth.projectId },
        select: { id: true },
      })
    : null;
  if (!session) throw new AppError("not_found", "No such session.");
  let after = 0n;
  if (q.cursor) {
    const [seq] = decodeCursor(q.cursor);
    if (!seq || !/^\d{1,18}$/.test(seq))
      throw new AppError("invalid_request", "Malformed cursor.", {
        param: "cursor",
      });
    after = BigInt(seq);
  }
  const rows = await ctx.db.sessionEvent.findMany({
    where: { sessionId: session.id, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(
      (e) =>
        ({
          id: publicEventId(e.id),
          sessionId: publicSessionId(e.sessionId),
          at: e.at.toISOString(),
          type: e.type,
          data: e.data,
        }) as SessionEvent,
    ),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor([last.seq.toString()])
        : null,
  };
}

export { NON_TERMINAL, TERMINAL };
