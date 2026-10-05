import { readFileSync } from "node:fs";
import { KestrelClient } from "./client.js";
import { makeReport, type Report } from "./report.js";
import { summarize } from "./stats.js";

/**
 * The churn check: how fast the platform makes and destroys browsers when sessions are short and
 * back to back, the load the public lifecycle benchmarks apply. Each worker creates a session (the
 * call returns once the browser is ready), stops it, and goes again, for a fixed time. It reports
 * the sustained rate of fresh browsers, create latency at the API over the whole run and per
 * slice of it (a pool that drains shows as a later slice getting slower), how many starts were
 * served hot, and how long a stopped session takes to be gone.
 *
 * Run it with the pool off to measure creation itself, and with it on to see what the pool
 * hides. Targets are optional: without them the check only records.
 */
export interface ChurnConfig {
  apiUrl: string;
  apiKey: string;
  /** Workers creating and stopping at once. */
  concurrency: number[];
  durationMs: number;
  /** Nodes serving the run, to give a rate per node. */
  nodes: number;
  targets: {
    ratePerNode?: number;
    createP50Ms?: number;
    createP99Ms?: number;
  };
  environment: Record<string, string | number>;
  log: (m: string) => void;
}

interface Sample {
  at: number;
  createMs: number;
  path: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function phase(
  client: KestrelClient,
  workers: number,
  durationMs: number,
): Promise<{
  samples: Sample[];
  failures: string[];
  teardownMs: number[];
  elapsedMs: number;
}> {
  const samples: Sample[] = [];
  const failures: string[] = [];
  const teardownMs: number[] = [];
  const t0 = performance.now();
  const end = t0 + durationMs;
  let n = 0;
  const worker = async (): Promise<void> => {
    while (performance.now() < end) {
      const c0 = performance.now();
      try {
        const { session } = await client.create({ waitForCapacityMs: 30_000 });
        const c1 = performance.now();
        samples.push({
          at: c0 - t0,
          createMs: c1 - c0,
          path: session.startPath ?? "unknown",
        });
        await client.stop(session.id);
        // One stop in ten is followed until the session is gone, for the teardown time.
        if (n++ % 10 === 0) {
          const s0 = performance.now();
          for (let i = 0; i < 100; i++) {
            const s = await client.get(session.id);
            if (s.status === "stopped") {
              teardownMs.push(performance.now() - s0);
              break;
            }
            await sleep(20);
          }
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message.slice(0, 160) : String(e));
        await sleep(200);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return {
    samples,
    failures,
    teardownMs,
    elapsedMs: performance.now() - t0,
  };
}

const round = (s: ReturnType<typeof summarize>) => ({
  n: s.n,
  p50: Math.round(s.p50),
  p95: Math.round(s.p95),
  p99: Math.round(s.p99),
  max: Math.round(s.max),
});

export async function runChurn(cfg: ChurnConfig): Promise<Report> {
  const client = new KestrelClient(cfg.apiUrl, cfg.apiKey);
  const report = makeReport("churn", cfg.environment);
  for (const workers of cfg.concurrency) {
    cfg.log(`churn: ${workers} at once for ${cfg.durationMs / 1000} s`);
    const r = await phase(client, workers, cfg.durationMs);
    const create = summarize(r.samples.map((s) => s.createMs));
    const rate = r.samples.length / (r.elapsedMs / 1000);
    const perNode = rate / cfg.nodes;
    const hot = r.samples.filter((s) => s.path === "hot").length;
    // Five slices of the run: a pool that runs dry shows as the later ones getting slower.
    const slices = Array.from({ length: 5 }, (_, i) => {
      const lo = (cfg.durationMs / 5) * i;
      const hi = lo + cfg.durationMs / 5;
      return round(
        summarize(
          r.samples
            .filter((s) => s.at >= lo && s.at < hi)
            .map((s) => s.createMs),
        ),
      );
    });
    const key = `c${workers}`;
    report.measure(key, {
      browsersPerSecond: Number(rate.toFixed(2)),
      browsersPerSecondPerNode: Number(perNode.toFixed(2)),
      createMs: round(create),
      createMsBySlice: slices,
      hot: `${hot}/${r.samples.length}`,
      teardownMs: round(summarize(r.teardownMs)),
      failures: r.failures.length,
      firstFailures: r.failures.slice(0, 3),
    });
    cfg.log(
      `churn ${key}: ${rate.toFixed(2)}/s (${perNode.toFixed(2)} per node), create p50 ${Math.round(create.p50)} p99 ${Math.round(create.p99)} ms, hot ${hot}/${r.samples.length}, failures ${r.failures.length}`,
    );
    report.add({
      id: `${key}-failures`,
      name: `no failures at ${workers} at once`,
      pass: r.failures.length === 0 && r.samples.length > 0,
      detail: `${r.samples.length} sessions, ${r.failures.length} failed`,
    });
    const t = cfg.targets;
    if (t.ratePerNode !== undefined)
      report.add({
        id: `${key}-rate`,
        name: `at least ${t.ratePerNode} fresh browsers/s per node at ${workers} at once`,
        pass: perNode >= t.ratePerNode,
        detail: `${perNode.toFixed(2)} per node`,
      });
    if (t.createP50Ms !== undefined || t.createP99Ms !== undefined)
      report.add({
        id: `${key}-latency`,
        name: `create at the API within p50 ${t.createP50Ms ?? "-"} / p99 ${t.createP99Ms ?? "-"} ms at ${workers} at once`,
        pass:
          (t.createP50Ms === undefined || create.p50 <= t.createP50Ms) &&
          (t.createP99Ms === undefined || create.p99 <= t.createP99Ms),
        detail: `p50 ${Math.round(create.p50)}, p99 ${Math.round(create.p99)}`,
      });
  }
  return report.build();
}

export function churnConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): ChurnConfig {
  const num = (k: string): number | undefined =>
    env[k] === undefined || env[k] === "" ? undefined : Number(env[k]);
  const keyFile = env.API_KEY_FILE;
  if (!keyFile && !env.API_KEY) throw new Error("API_KEY_FILE is required");
  return {
    apiUrl: env.API_URL ?? "http://127.0.0.1:8080",
    apiKey: env.API_KEY ?? readFileSync(keyFile as string, "utf8").trim(),
    concurrency: (env.CHURN_CONCURRENCY ?? "1,4,10")
      .split(",")
      .map(Number)
      .filter((n) => n > 0),
    durationMs: (num("CHURN_SECONDS") ?? 60) * 1000,
    nodes: num("NODES") ?? (env.TWO_NODES === "1" ? 2 : 1),
    targets: {
      ...(num("TARGET_RATE_PER_NODE") !== undefined
        ? { ratePerNode: num("TARGET_RATE_PER_NODE") }
        : {}),
      ...(num("TARGET_CREATE_P50_MS") !== undefined
        ? { createP50Ms: num("TARGET_CREATE_P50_MS") }
        : {}),
      ...(num("TARGET_CREATE_P99_MS") !== undefined
        ? { createP99Ms: num("TARGET_CREATE_P99_MS") }
        : {}),
    },
    environment: {
      pool: env.POOL ?? "unknown",
      slots: env.SLOTS ?? "unknown",
      runtime: env.RUNTIME ?? "docker",
      instance: env.INSTANCE_TYPE ?? "unknown",
    },
    log,
  };
}
