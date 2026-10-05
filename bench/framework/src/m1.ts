import { readFileSync } from "node:fs";
import Docker from "dockerode";
import WebSocket from "ws";
import { chromium, type BrowserContext } from "playwright-core";
import { KestrelClient } from "./client.js";
import { DEFAULT_HOST, settledInvariants, type HostConfig } from "./collect.js";
import {
  PlaywrightDiscoveryDriver,
  PlaywrightDriver,
  PuppeteerDriver,
} from "./driver.js";
import { checkInvariants } from "./invariants.js";
import { runIsolationSuite, type IsolationConfig } from "./isolation.js";
import { runChaos } from "./chaos.js";
import { runBatch } from "./lifecycle.js";
import { makeReport, type Report } from "./report.js";
import { summarize } from "./stats.js";

export interface M1Config {
  /** Where the harness talks to the API: the local listener, so TLS and Caddy are not in the measurement. */
  apiUrl: string;
  /** What clients are given in `connectUrl`. */
  publicHostname: string;
  publicIp: string;
  apiKey: string;
  testPageUrl: string;
  sequentialCount: number;
  concurrentCount: number;
  concurrency: number;
  latencySamples: number;
  host: HostConfig;
  isolation: Omit<
    IsolationConfig,
    "publicIp" | "publicHostname" | "testPageUrl"
  >;
  environment: Record<string, string | number>;
  only?: number[];
  chaosOnly?: string[];
  chaosRepeat: number;
  log: (m: string) => void;
}

const EXPECT_TITLE = "Kestrel test page";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHot(host: HostConfig, ms: number): Promise<void> {
  const n = host.nodes[0];
  if (!n) return;
  const secret = readFileSync(n.secretFile, "utf8").trim();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = (await (
        await fetch(`http://127.0.0.1:${n.agentPort}/v1/describe`, {
          headers: { authorization: `Bearer ${secret}` },
        })
      ).json()) as { hotCount: number };
      if (r.hotCount >= 1) return;
    } catch {
      /* try again */
    }
    await sleep(100);
  }
}

export async function runM1(c: M1Config): Promise<Report> {
  const client = new KestrelClient(c.apiUrl, c.apiKey, 120_000);
  const report = makeReport("m1-exit-check", c.environment);
  const want = (n: number) => !c.only || c.only.includes(n);
  const common = { testPageUrl: c.testPageUrl, expectTitle: EXPECT_TITLE };
  const invariants = async (label: string): Promise<void> => {
    const r = await settledInvariants(checkInvariants, c.host);
    report.add({
      id: "3",
      name: `invariants after ${label}`,
      pass: r.ok,
      detail: r.ok
        ? "nothing leaked or inconsistent"
        : r.violations
            .slice(0, 6)
            .map((v) => `${v.rule}: ${v.detail}`)
            .join("; "),
    });
  };

  if (want(1)) {
    c.log(`check 1: ${c.sequentialCount} sequential lifecycles`);
    const b = await runBatch(client, new PlaywrightDriver(), {
      ...common,
      count: c.sequentialCount,
      concurrency: 1,
      create: { viewport: { width: 1280, height: 720 } },
      expectViewport: { width: 1280, height: 720 },
      onProgress: (d, f) => d % 50 === 0 && c.log(`  ${d} done, ${f} failed`),
    });
    report.add({
      id: "1",
      name: `${c.sequentialCount} sequential lifecycles`,
      pass: b.failures.length === 0 && b.hotShare >= 0.95,
      detail: `${b.failures.length} failures, ${(b.hotShare * 100).toFixed(1)}% hot${b.failures[0] ? `; first: ${b.failures[0].phase}: ${b.failures[0].error}` : ""}`,
    });
    report.measure("sequential", {
      create: b.create,
      connect: b.connect,
      nav: b.nav,
      stop: b.stop,
      lifecycle: b.lifecycle,
      wallMs: b.wallMs,
    });
    await invariants("the sequential run");
  }

  if (want(2)) {
    c.log(
      `check 2: ${c.concurrentCount} lifecycles, ${c.concurrency} at a time`,
    );
    const b = await runBatch(client, new PlaywrightDriver(), {
      ...common,
      count: c.concurrentCount,
      concurrency: c.concurrency,
      waitForCapacityMs: 30_000,
      onProgress: (d, f) => d % 50 === 0 && c.log(`  ${d} done, ${f} failed`),
    });
    report.add({
      id: "2",
      name: `${c.concurrentCount} lifecycles at ${c.concurrency} concurrent`,
      pass: b.failures.length === 0,
      detail: `${b.failures.length} failures, ${(b.hotShare * 100).toFixed(1)}% hot${b.failures[0] ? `; first: ${b.failures[0].phase}: ${b.failures[0].error}` : ""}`,
    });
    report.measure("concurrent", {
      create: b.create,
      connect: b.connect,
      nav: b.nav,
      stop: b.stop,
      lifecycle: b.lifecycle,
      wallMs: b.wallMs,
    });
    await invariants("the concurrent run");
  }

  if (want(4)) {
    c.log("check 4: isolation suite");
    const findings = await runIsolationSuite(client, {
      ...c.isolation,
      publicIp: c.publicIp,
      publicHostname: c.publicHostname,
      testPageUrl: c.testPageUrl,
    });
    const failed = findings.filter((f) => !f.pass);
    report.add({
      id: "4",
      name: `isolation suite (${findings.length} attacks and controls, 3 kinds)`,
      pass: failed.length === 0,
      detail: failed.length
        ? failed
            .slice(0, 5)
            .map((f) => `[kind ${f.kind}] ${f.name}: ${f.detail}`)
            .join("; ")
        : "every forbidden target refused; every control passed",
    });
    report.measure("isolation", findings);
    await invariants("the isolation suite");
  }

  if (want(5)) {
    c.log("check 5: policy");
    const host = new URL(c.testPageUrl).hostname;
    const { session } = await client.create({ network: { allow: [host] } });
    const browser = await chromium.connectOverCDP(
      session.connectUrl as string,
      { timeout: 30_000 },
    );
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let listed: string;
    let unlisted: string;
    try {
      await page.goto(c.testPageUrl, { timeout: 20_000 });
      listed = await page.title();
    } catch (e) {
      listed = `error: ${(e as Error).message.slice(0, 80)}`;
    }
    let unlistedRefused: boolean;
    try {
      const r = await page.goto("https://example.com/", { timeout: 15_000 });
      unlisted = `status ${r?.status()}`;
      unlistedRefused = (r?.status() ?? 0) >= 400;
    } catch (e) {
      unlisted = (e as Error).message.split("\n")[0] ?? "";
      unlistedRefused = true;
    }
    await browser.close().catch(() => undefined);
    await client.stop(session.id);
    const deny = await client.create({ network: { deny: [host] } });
    const b2 = await chromium.connectOverCDP(
      deny.session.connectUrl as string,
      { timeout: 30_000 },
    );
    const p2 =
      (b2.contexts()[0] ?? (await b2.newContext())).pages()[0] ??
      (await (b2.contexts()[0] as BrowserContext).newPage());
    let denied: boolean;
    try {
      const r = await p2.goto(c.testPageUrl, { timeout: 15_000 });
      denied = (r?.status() ?? 0) >= 400;
    } catch {
      denied = true;
    }
    await b2.close().catch(() => undefined);
    await client.stop(deny.session.id);
    report.add({
      id: "5",
      name: "allow and deny lists",
      pass: listed === EXPECT_TITLE && unlistedRefused && denied,
      detail: `listed host: ${listed}; unlisted host: ${unlisted}; denied host refused: ${denied}`,
    });
  }

  if (want(6)) {
    c.log(`check 6: ${c.latencySamples} create latencies at the API`);
    const times: number[] = [];
    const samples: { ms: number; path: string | null; hotBefore: number }[] =
      [];
    let hot = 0;
    for (let i = 0; i < c.latencySamples; i++) {
      const t0 = performance.now();
      const { session } = await client.create({});
      times.push(performance.now() - t0);
      samples.push({
        ms: Math.round(performance.now() - t0),
        path: session.startPath,
        hotBefore: -1,
      });
      if (session.startPath === "hot") hot++;
      await client.stop(session.id);
      await client.waitFor(
        session.id,
        ["stopped", "failed", "timed_out"],
        20_000,
      );
      // The target is for a pool that is keeping up: wait until a browser is ready again before the next sample.
      await waitForHot(c.host, 8_000);
    }
    const hotTimes = times.filter((_, i) => i >= 0);
    const s = summarize(hotTimes);
    report.add({
      id: "6",
      name: "hot create latency at the API (median <= 150 ms, p99 <= 500 ms)",
      pass: s.p50 <= 150 && s.p99 <= 500 && hot / times.length >= 0.95,
      detail: `p50 ${s.p50.toFixed(0)} ms, p95 ${s.p95.toFixed(0)} ms, p99 ${s.p99.toFixed(0)} ms, ${((hot / times.length) * 100).toFixed(0)}% hot, n=${times.length}`,
    });
    report.measure("createLatencyMs", s);
    report.measure("createSamples", samples);
  }

  if (want(7)) {
    c.log("check 7: lifetime");
    // A session with a 20 s timeout ends within 25 s.
    const a = await client.create({ timeout: 20_000, idleTimeout: 60_000 });
    const t0 = Date.now();
    const endedA = await client
      .waitFor(a.session.id, ["stopped", "failed", "timed_out"], 40_000)
      .catch(() => null);
    const tA = (Date.now() - t0) / 1000;
    // A session never connected to ends at its idle timeout.
    const b = await client.create({ idleTimeout: 5_000 });
    const t1 = Date.now();
    const endedB = await client
      .waitFor(b.session.id, ["stopped", "failed", "timed_out"], 30_000)
      .catch(() => null);
    const tB = (Date.now() - t1) / 1000;
    // A session left attached across an agent restart is not ended by the idle timer.
    const cS = await client.create({ idleTimeout: 10_000 });
    const browser = await chromium.connectOverCDP(
      cS.session.connectUrl as string,
      { timeout: 30_000 },
    );
    await new Docker({ socketPath: "/var/run/docker.sock" })
      .getContainer("kestrel-node-a-1")
      .restart({ t: 5 });
    await sleep(35_000);
    const still = await client.get(cS.session.id);
    await browser.close().catch(() => undefined);
    await client.stop(cS.session.id);
    const okA =
      endedA?.status === "timed_out" &&
      endedA.endReason === "max_lifetime" &&
      tA <= 25;
    const okB =
      endedB?.status === "timed_out" &&
      endedB.endReason === "idle_timeout" &&
      tB <= 12;
    const okC = still.status === "active" || still.status === "ready";
    report.add({
      id: "7",
      name: "lifetime: timeout, idle timeout, attached across an agent restart",
      pass: okA && okB && okC,
      detail: `20 s timeout ended ${endedA?.endReason} after ${tA.toFixed(1)} s (limit 25); idle 5 s ended ${endedB?.endReason} after ${tB.toFixed(1)} s; attached session after agent restart: ${still.status}`,
    });
    await invariants("the lifetime checks");
  }

  if (want(8)) {
    c.log("check 8: compatibility");
    const parts: string[] = [];
    let ok = true;
    for (const d of [
      new PlaywrightDriver(),
      new PlaywrightDiscoveryDriver(),
      new PuppeteerDriver(),
    ]) {
      const b = await runBatch(client, d, {
        ...common,
        count: 3,
        concurrency: 1,
        create: { viewport: { width: 1000, height: 640 } },
        expectViewport: { width: 1000, height: 640 },
      });
      parts.push(
        `${d.name} ${b.total - b.failures.length}/${b.total}${b.failures[0] ? ` (${b.failures[0].phase}: ${b.failures[0].error?.slice(0, 60)})` : ""}`,
      );
      if (b.failures.length) ok = false;
    }
    // A page-level socket, reached through the discovery endpoint.
    const { session } = await client.create({});
    try {
      const u = new URL(session.connectUrl as string);
      const base = `https://${u.host}${u.pathname}`;
      const list = (await (
        await fetch(`${base}/json/list${u.search}`)
      ).json()) as { webSocketDebuggerUrl?: string }[];
      const pageWs = list[0]?.webSocketDebuggerUrl;
      const result = await new Promise<string>((resolve) => {
        if (!pageWs) return resolve("no page socket in /json/list");
        const ws = new WebSocket(pageWs);
        const t = setTimeout(() => (ws.close(), resolve("timeout")), 15_000);
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression: "6*7", returnByValue: true },
            }),
          ),
        );
        ws.on("message", (d) => {
          clearTimeout(t);
          ws.close();
          resolve(
            String(
              (
                JSON.parse(d.toString()) as {
                  result?: { result?: { value?: unknown } };
                }
              ).result?.result?.value,
            ),
          );
        });
        ws.on("error", (e) => {
          clearTimeout(t);
          resolve(`error ${e.message}`);
        });
      });
      parts.push(`page-level socket ${result === "42" ? "ok" : result}`);
      if (result !== "42") ok = false;
    } finally {
      await client.stop(session.id);
    }
    report.add({
      id: "8",
      name: "compatibility: Playwright wss and https, Puppeteer wss, a page-level socket, exact viewport",
      pass: ok,
      detail: parts.join("; "),
    });
  }

  if (want(9)) {
    c.log("check 9: chaos cases");
    const results = await runChaos(
      {
        client,
        host: c.host,
        testPageUrl: c.testPageUrl,
        publicHostname: c.publicHostname,
        log: c.log,
      },
      { ...(c.chaosOnly ? { only: c.chaosOnly } : {}), repeat: c.chaosRepeat },
    );
    const failed = results.filter((r) => !r.pass);
    report.add({
      id: "9",
      name: `chaos cases (${results.length} runs, each followed by the invariant checker)`,
      pass: failed.length === 0,
      detail: failed.length
        ? failed
            .map((r) => `${r.id}: ${r.detail}`)
            .join("; ")
            .slice(0, 900)
        : "every case held its invariants",
    });
    report.measure("chaos", results);
  }

  return report.build();
}

export function m1ConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): M1Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const quick = env.QUICK === "1";
  return {
    apiUrl: env.API_URL ?? "http://127.0.0.1:8080",
    publicHostname: need("PUBLIC_HOSTNAME"),
    publicIp: need("PUBLIC_IP"),
    apiKey: readFileSync(need("API_KEY_FILE"), "utf8").trim(),
    testPageUrl: need("TEST_PAGE_URL"),
    sequentialCount: Number(env.SEQ_COUNT ?? (quick ? 20 : 500)),
    concurrentCount: Number(env.CONC_COUNT ?? (quick ? 16 : 300)),
    concurrency: Number(env.CONCURRENCY ?? 4),
    latencySamples: Number(env.LATENCY_SAMPLES ?? (quick ? 20 : 200)),
    host:
      env.TWO_NODES === "1"
        ? {
            ...DEFAULT_HOST,
            nodes: [
              ...DEFAULT_HOST.nodes,
              {
                id: "b",
                agentPort: 7002,
                gatewayMetricsPort: 7202,
                secretFile: "/secrets/node-b.secret",
                iface: "ksl-b",
                bridgeIp: "172.30.2.1",
                egressSocket: "/run/kestrel/b/egress.sock",
              },
            ],
          }
        : DEFAULT_HOST,
    isolation: {
      node: "a",
      network: "ksl-a",
      bridgeIp: "172.30.1.1",
      egressSocket: "/run/kestrel/a/egress.sock",
      probeImage: env.PROBE_IMAGE ?? "kestrel-platform:dev",
    },
    environment: {
      instanceType: env.INSTANCE_TYPE ?? "unknown",
      hostname: need("PUBLIC_HOSTNAME"),
      sessionSize: "1 CPU / 2 GB",
      slots: Number(env.SLOTS ?? 5),
      poolTarget: Number(env.POOL ?? 2),
      tenancy: "single-tenant, one dedicated host",
      quick: quick ? "yes" : "no",
    },
    ...(env.ONLY ? { only: env.ONLY.split(",").map(Number) } : {}),
    ...(env.CHAOS_ONLY ? { chaosOnly: env.CHAOS_ONLY.split(",") } : {}),
    chaosRepeat: Number(env.CHAOS_REPEAT ?? 1),
    log,
  };
}
