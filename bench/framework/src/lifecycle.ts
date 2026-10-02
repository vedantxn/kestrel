import { ApiError, type KestrelClient } from "./client.js";
import type { Driver } from "./driver.js";
import { summarize, type Summary } from "./stats.js";

export interface LifecycleOptions {
  /** The static page every lifecycle loads (H2): its failure fails the run. */
  testPageUrl: string;
  expectTitle: string;
  /** Options passed to every create. */
  create?: Record<string, unknown>;
  /** The viewport the page must report back, if one was requested (check 8). */
  expectViewport?: { width: number; height: number };
  /** How long a stopped session has to reach a final status. */
  settleMs?: number;
}

export interface LifecycleResult {
  ok: boolean;
  /** Where it failed: create, connect, load, assert, stop, settle. */
  phase?: string;
  error?: string;
  sessionId?: string;
  startPath?: "hot" | "cold" | null;
  createMs: number;
  connectMs?: number;
  navMs?: number;
  stopMs?: number;
  /** Create to terminal status, whole. */
  totalMs: number;
}

/**
 * One lifecycle, the unit every benchmark measures: create, connect, navigate, release. It stops
 * its session whether or not it succeeded, and then waits for a terminal status, so a failed run
 * never leaves a session behind to confuse the next one.
 */
export async function runLifecycle(
  client: KestrelClient,
  driver: Driver,
  o: LifecycleOptions,
): Promise<LifecycleResult> {
  const t0 = performance.now();
  const result: LifecycleResult = { ok: false, createMs: 0, totalMs: 0 };
  let id: string | undefined;
  try {
    const c0 = performance.now();
    const { session } = await client.create(o.create ?? {}).catch((e) => {
      throw tag("create", e);
    });
    result.createMs = performance.now() - c0;
    id = session.id;
    result.sessionId = id;
    result.startPath = session.startPath;

    let drove;
    try {
      drove = await driver.drive(session, o.testPageUrl);
    } catch (e) {
      throw tag("connect", e);
    }
    result.connectMs = drove.connectMs;
    result.navMs = drove.navMs;
    if (drove.title !== o.expectTitle)
      throw tag(
        "load",
        new Error(
          `the page title was ${JSON.stringify(drove.title)}, wanted ${JSON.stringify(o.expectTitle)}`,
        ),
      );
    if (
      o.expectViewport &&
      (drove.innerWidth !== o.expectViewport.width ||
        drove.innerHeight !== o.expectViewport.height)
    ) {
      throw tag(
        "assert",
        new Error(
          `the page measured ${drove.innerWidth}x${drove.innerHeight}, wanted ${o.expectViewport.width}x${o.expectViewport.height}`,
        ),
      );
    }
    result.ok = true;
  } catch (e) {
    const t = e as Tagged;
    result.phase = t.phase ?? "unknown";
    result.error =
      (t.cause as Error | undefined)?.message ?? (e as Error).message;
  } finally {
    if (id) {
      const s0 = performance.now();
      try {
        await client.stop(id);
        await client.waitFor(
          id,
          ["stopped", "failed", "timed_out"],
          o.settleMs ?? 20_000,
        );
        result.stopMs = performance.now() - s0;
      } catch (e) {
        if (result.ok) {
          result.ok = false;
          result.phase = "settle";
          result.error = (e as Error).message;
        }
      }
    }
    result.totalMs = performance.now() - t0;
  }
  return result;
}

interface Tagged extends Error {
  phase?: string;
}
function tag(phase: string, cause: unknown): Tagged {
  const e = new Error(
    cause instanceof ApiError ? cause.message : (cause as Error).message,
  ) as Tagged;
  e.phase = phase;
  (e as { cause?: unknown }).cause = cause;
  return e;
}

export interface BatchOptions extends LifecycleOptions {
  count: number;
  concurrency: number;
  /** Passed to every create so a full platform waits instead of refusing (A11). */
  waitForCapacityMs?: number;
  onProgress?: (done: number, failed: number) => void;
}

export interface BatchResult {
  total: number;
  failures: LifecycleResult[];
  hotShare: number;
  create: Summary;
  connect: Summary;
  nav: Summary;
  stop: Summary;
  lifecycle: Summary;
  wallMs: number;
}

/** Run `count` lifecycles with at most `concurrency` at a time. */
export async function runBatch(
  client: KestrelClient,
  driver: Driver,
  o: BatchOptions,
): Promise<BatchResult> {
  const results: LifecycleResult[] = [];
  let next = 0;
  let failed = 0;
  const wall0 = performance.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= o.count) return;
      const r = await runLifecycle(client, driver, {
        ...o,
        create: {
          ...o.create,
          ...(o.waitForCapacityMs
            ? { waitForCapacityMs: o.waitForCapacityMs }
            : {}),
        },
      });
      results.push(r);
      if (!r.ok) failed++;
      o.onProgress?.(results.length, failed);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(o.concurrency, o.count) }, () => worker()),
  );
  const ok = results.filter((r) => r.ok);
  const nums = (f: (r: LifecycleResult) => number | undefined) =>
    results.map(f).filter((v): v is number => typeof v === "number");
  return {
    total: results.length,
    failures: results.filter((r) => !r.ok),
    hotShare: results.length
      ? results.filter((r) => r.startPath === "hot").length / results.length
      : 0,
    create: summarize(nums((r) => r.createMs)),
    connect: summarize(nums((r) => r.connectMs)),
    nav: summarize(nums((r) => r.navMs)),
    stop: summarize(nums((r) => r.stopMs)),
    lifecycle: summarize(ok.map((r) => r.totalMs)),
    wallMs: performance.now() - wall0,
  };
}
