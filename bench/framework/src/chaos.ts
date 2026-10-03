import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import Docker from "dockerode";
import { chromium, type Browser, type Page } from "playwright-core";
import WebSocket from "ws";
import type { Session } from "@kestrel/contracts";
import { ApiError, type KestrelClient } from "./client.js";
import { settledInvariants, type HostConfig } from "./collect.js";
import { PlaywrightDriver } from "./driver.js";
import { checkInvariants } from "./invariants.js";
import { runLifecycle } from "./lifecycle.js";

/**
 * v1 plan section 7, "Chaos cases". Each case injects one fault, checks what must hold, and the
 * runner then runs the invariant checker: nothing leaked, nothing inconsistent, no failpoint left on.
 * A case throws with a plain-language message if what must hold does not.
 */
export interface ChaosEnv {
  client: KestrelClient;
  host: HostConfig;
  testPageUrl: string;
  publicHostname: string;
  log: (m: string) => void;
}

export interface ChaosCase {
  id: string;
  name: string;
  /** Returns a short description of what was observed. */
  run(env: ChaosEnv): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const TERMINAL = ["stopped", "failed", "timed_out"] as const;

// --- helpers ------------------------------------------------------------------------------------

function sh(
  cmd: string,
  env: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", cmd],
      {
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

const COMPOSE =
  "docker compose -p kestrel --env-file /var/lib/kestrel/compose.env -f /srv/kestrel/infra/compose/docker-compose.yml --profile b";
const compose = (args: string, env: Record<string, string> = {}) =>
  sh(`cd /srv/kestrel && ${COMPOSE} ${args}`, env);
const container = (name: string) => docker.getContainer(name);

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | false | null | undefined>,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end)
      throw new Error(
        `${what} did not happen within ${Math.round(ms / 1000)} s`,
      );
    await sleep(everyMs);
  }
}

interface Held {
  session: Session;
  browser: Browser;
  page: Page;
}

/** Sessions with a real client attached, each having loaded the test page. */
async function hold(
  env: ChaosEnv,
  n: number,
  opts: Record<string, unknown> = {},
): Promise<Held[]> {
  const out: Held[] = [];
  for (let i = 0; i < n; i++) {
    const { session } = await env.client.create({
      waitForCapacityMs: 20_000,
      ...opts,
    });
    const browser = await chromium.connectOverCDP(
      session.connectUrl as string,
      { timeout: 30_000 },
    );
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(env.testPageUrl, { timeout: 30_000 });
    out.push({ session, browser, page });
  }
  return out;
}

async function usable(h: Held, ms = 15_000): Promise<boolean> {
  try {
    return (
      (await Promise.race([
        h.page.evaluate("1 + 1"),
        sleep(ms).then(() => -1),
      ])) === 2
    );
  } catch {
    return false;
  }
}

async function release(held: Held[], client: KestrelClient): Promise<void> {
  for (const h of held) {
    await h.browser.close().catch(() => undefined);
    await client.stop(h.session.id).catch(() => undefined);
  }
}

async function stopAll(env: ChaosEnv): Promise<void> {
  for (const s of await env.client.list("?limit=100")) {
    if (
      !(TERMINAL as readonly string[]).includes(s.status) &&
      s.status !== "stopping"
    )
      await env.client.stop(s.id).catch(() => undefined);
  }
}

function secretOf(host: HostConfig, node: string): string {
  const n = host.nodes.find((x) => x.id === node);
  expect(n, `no node ${node}`);
  return readFileSync(n.secretFile, "utf8").trim();
}

/** Which container serves a session, from its node agent's own store. */
async function containerOf(
  env: ChaosEnv,
  sessionId: string,
): Promise<{ id: string; node: string } | null> {
  for (const n of env.host.nodes) {
    try {
      const r = await fetch(`http://127.0.0.1:${n.agentPort}/v1/state`, {
        headers: { authorization: `Bearer ${secretOf(env.host, n.id)}` },
      });
      const st = (await r.json()) as {
        sessions: { sessionId: string; containerId: string | null }[];
      };
      const b = st.sessions.find((s) => s.sessionId === sessionId);
      if (b?.containerId) return { id: b.containerId, node: n.id };
    } catch {
      /* try the next node */
    }
  }
  return null;
}

async function inContainer(id: string, script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      ["exec", "-i", id, "sh"],
      { timeout: 60_000 },
      (_e, stdout, stderr) => resolve(`${stdout}${stderr}`),
    );
    child.stdin?.end(script);
  });
}

const KILL_BY = (pattern: string) =>
  `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in *${pattern}*) kill -9 \${p#/proc/} 2>/dev/null;; esac; done`;

/** SIGKILL a container's main process from the host, as a crash would: the restart policy applies (it does not for `docker kill`). */
async function crash(name: string): Promise<void> {
  const pid = (
    await sh(`docker inspect -f '{{.State.Pid}}' ${name}`)
  ).out.trim();
  expect(/^\d+$/.test(pid) && pid !== "0", `${name} is not running`);
  await sh(
    `docker run --rm --pid=host -u 0:0 --entrypoint kill kestrel-platform:dev -9 ${pid}`,
  );
}

async function neighbourWorks(env: ChaosEnv, ms = 40_000): Promise<string> {
  const r = await runLifecycle(env.client, new PlaywrightDriver(), {
    testPageUrl: env.testPageUrl,
    expectTitle: "Kestrel test page",
  });
  expect(
    r.ok,
    `a neighbouring session's script failed (${r.phase}: ${r.error})`,
  );
  expect(
    r.totalMs < ms,
    `a neighbouring session's script took ${Math.round(r.totalMs)} ms`,
  );
  return `neighbour lifecycle ok in ${Math.round(r.totalMs)} ms`;
}

async function expectEnds(
  env: ChaosEnv,
  id: string,
  reasons: string[],
  ms = 40_000,
): Promise<Session> {
  const s = await env.client.waitFor(id, [...TERMINAL], ms);
  expect(
    s.endReason && reasons.includes(s.endReason),
    `the session ended ${s.status}/${s.endReason}, wanted one of ${reasons.join(", ")}`,
  );
  return s;
}

async function apiHealthy(env: ChaosEnv, ms = 60_000): Promise<void> {
  await until("the API to answer", ms, async () => {
    try {
      await env.client.list("?limit=1");
      return true;
    } catch {
      return false;
    }
  });
}

async function createsWork(env: ChaosEnv): Promise<string> {
  const r = await until("a create to succeed", 60_000, async () => {
    try {
      return await env.client.create({});
    } catch {
      return false;
    }
  });
  await env.client.stop(r.session.id);
  return "creates resume";
}

async function noNodeLost(env: ChaosEnv): Promise<void> {
  const all = await env.client.list("?limit=100");
  expect(
    !all.some(
      (s) =>
        s.endReason === "node_lost" &&
        Date.now() - Date.parse(s.createdAt) < 120_000,
    ),
    "a node was wrongly declared lost",
  );
}

const failpointEnv = (spec: string) => ({ KESTREL_FAILPOINTS: spec });
async function setApiFailpoints(spec: string): Promise<void> {
  await compose("up -d api", failpointEnv(spec));
}

// --- the cases (v1 plan section 7) ----------------------------------------------------------------

export const CASES: ChaosCase[] = [
  {
    id: "kill-chrome",
    name: "Kill Chrome inside a session",
    async run(env) {
      const [a] = await hold(env, 1);
      const where = await containerOf(env, a!.session.id);
      expect(where, "could not find the session's container");
      await inContainer(where.id, KILL_BY("/opt/chrome/chrome"));
      const s = await expectEnds(env, a!.session.id, [
        "browser_crash",
        "runtime_crash",
      ]);
      await a!.browser.close().catch(() => undefined);
      return `${s.status}/${s.endReason}; ${await neighbourWorks(env)}`;
    },
  },
  {
    id: "kill-runtimed",
    name: "Kill runtimed inside a session",
    async run(env) {
      const [a] = await hold(env, 1);
      const where = await containerOf(env, a!.session.id);
      expect(where, "could not find the session's container");
      await inContainer(where.id, KILL_BY("runtimed.mjs"));
      const s = await expectEnds(env, a!.session.id, [
        "browser_crash",
        "runtime_crash",
      ]);
      await a!.browser.close().catch(() => undefined);
      return `${s.status}/${s.endReason}; ${await neighbourWorks(env)}`;
    },
  },
  {
    id: "remove-container",
    name: "Force-remove a session's container",
    async run(env) {
      const [a] = await hold(env, 1);
      const where = await containerOf(env, a!.session.id);
      expect(where, "could not find the session's container");
      await sh(`docker rm -f ${where.id}`);
      const s = await expectEnds(env, a!.session.id, [
        "browser_crash",
        "runtime_crash",
        "oom",
      ]);
      await a!.browser.close().catch(() => undefined);
      return `${s.status}/${s.endReason}; ${await neighbourWorks(env)}`;
    },
  },
  {
    id: "memory",
    name: "A session exceeds its memory limit",
    async run(env) {
      const [a] = await hold(env, 1);
      const eat = a!.page
        .evaluate(
          "(() => { const a = []; for (;;) a.push(new Array(2e6).fill(1.5)); })()",
        )
        .catch((e: Error) => e.message.slice(0, 60));
      const neighbour = await neighbourWorks(env, 60_000);
      const outcome = await Promise.race([
        eat,
        sleep(30_000).then(() => "still running"),
      ]);
      await a!.browser.close().catch(() => undefined);
      const s = await env.client.get(a!.session.id);
      return `the hog: ${String(outcome).slice(0, 50)}, session ${s.status}; ${neighbour}`;
    },
  },
  {
    id: "disk-cpu",
    name: "A session fills its profile space and spins its CPU",
    async run(env) {
      const [a] = await hold(env, 1);
      const where = await containerOf(env, a!.session.id);
      expect(where, "could not find the session's container");
      void sh(
        `docker exec ${where.id} sh -c 'dd if=/dev/zero of=/profile/fill bs=1M count=700 2>&1; for i in 1 2 3 4; do (while :; do :; done) & done; sleep 25'`,
        {},
        60_000,
      );
      await sleep(3000);
      const neighbour = await neighbourWorks(env, 40_000);
      await a!.browser.close().catch(() => undefined);
      return neighbour;
    },
  },
  {
    id: "restart-agent",
    name: "Restart the node agent mid-run",
    async run(env) {
      const held = await hold(env, 3);
      await sh("docker restart kestrel-node-a-1");
      await sleep(25_000);
      const results = await Promise.all(held.map((h) => usable(h)));
      const states = await Promise.all(
        held.map((h) => env.client.get(h.session.id)),
      );
      const lost = states.filter(
        (s) => s.status !== "ready" && s.status !== "active",
      );
      await createsWork(env);
      await release(held, env.client);
      expect(
        lost.length === 0,
        `${lost.length} session(s) lost across the agent restart: ${lost.map((s) => `${s.status}/${s.endReason}`).join(",")}`,
      );
      expect(
        results.every(Boolean),
        "a held session stopped answering after the restart",
      );
      return "3 sessions survived with their clients attached";
    },
  },
  {
    id: "kill-agent-during-start",
    name: "Kill the node agent during a start",
    async run(env) {
      const creating = Array.from({ length: 5 }, () =>
        env.client
          .create({})
          .then((r) => r.session.id)
          .catch(() => null),
      );
      await sleep(40);
      await crash("kestrel-node-a-1");
      const ids = (await Promise.all(creating)).filter(
        (x) => x !== null,
      ) as string[];
      await sleep(25_000);
      await stopAll(env);
      for (const id of ids) {
        const s = await env.client
          .waitFor(id, [...TERMINAL], 60_000)
          .catch(() => null);
        expect(s, `session ${id} never ended`);
      }
      return `${ids.length} of 5 creates were admitted; all ended cleanly`;
    },
  },
  {
    id: "restart-api",
    name: "Restart the API mid-run",
    async run(env) {
      const held = await hold(env, 2);
      await sh("docker restart kestrel-api-1");
      const usableDuring = await Promise.all(held.map((h) => usable(h)));
      await apiHealthy(env);
      await sleep(20_000);
      await noNodeLost(env);
      const states = await Promise.all(
        held.map((h) => env.client.get(h.session.id)),
      );
      const detail = await createsWork(env);
      await release(held, env.client);
      expect(
        usableDuring.every(Boolean),
        "running sessions were affected by the API restart",
      );
      expect(
        states.every((s) => s.status === "ready" || s.status === "active"),
        "a running session changed state across the API restart",
      );
      return `sessions unaffected; ${detail}`;
    },
  },
  {
    id: "kill-api-after-reserve",
    name: "Kill the API between reserving and starting",
    async run(env) {
      await setApiFailpoints("api.create.after_reserve=exit");
      try {
        await apiHealthy(env);
        await env.client.create({}).catch(() => undefined);
        await sleep(2000);
        await setApiFailpoints("");
        await apiHealthy(env);
        const t0 = Date.now();
        const stranded = await until(
          "the stranded session to be ended by the sweeper",
          90_000,
          async () => {
            const all = await env.client.list("?limit=20");
            const s = all.find(
              (x) => x.status === "failed" && x.endReason === "start_timeout",
            );
            return s ?? false;
          },
          2000,
        );
        const took = Math.round((Date.now() - t0) / 1000);
        expect(took <= 60, `the sweeper took ${took} s (limit 60)`);
        return `ended ${stranded.status}/${stranded.endReason} ${took} s after the API came back; ${await createsWork(env)}`;
      } finally {
        await setApiFailpoints("");
      }
    },
  },
  {
    id: "stop-postgres",
    name: "Stop Postgres for 20 s",
    async run(env) {
      const held = await hold(env, 2);
      await compose("stop postgres");
      await sleep(20_000);
      const during = await Promise.all(held.map((h) => usable(h)));
      await compose("start postgres");
      await apiHealthy(env, 90_000);
      await sleep(20_000);
      await noNodeLost(env);
      const states = await Promise.all(
        held.map((h) => env.client.get(h.session.id)),
      );
      const detail = await createsWork(env);
      await release(held, env.client);
      expect(
        during.every(Boolean),
        "running sessions were affected by the database outage",
      );
      expect(
        states.every((s) => s.status === "ready" || s.status === "active"),
        "a running session changed state across the outage",
      );
      return `sessions unaffected, no node wrongly lost; ${detail}`;
    },
  },
  {
    id: "lose-stop",
    name: "Lose a stop message",
    async run(env) {
      await setApiFailpoints("api.node_stop=drop:once");
      try {
        await apiHealthy(env);
        const { session } = await env.client.create({});
        const where = await containerOf(env, session.id);
        expect(where, "no container for the session");
        const t0 = Date.now();
        await env.client.stop(session.id);
        await until(
          "the container to be removed",
          10_000,
          async () =>
            !(await sh(`docker inspect ${where.id}`)).out.includes('"Running"'),
          500,
        );
        const s = await env.client.waitFor(session.id, [...TERMINAL], 20_000);
        return `container gone ${((Date.now() - t0) / 1000).toFixed(1)} s after the stop was lost; session ${s.status}`;
      } finally {
        await setApiFailpoints("");
      }
    },
  },
  {
    id: "lose-start",
    name: "Lose a start message",
    async run(env) {
      await setApiFailpoints("api.node_start=drop:once");
      try {
        await apiHealthy(env);
        const err = await env.client.create({}).then(
          () => null,
          (e: unknown) => e,
        );
        expect(
          err instanceof ApiError || err instanceof Error,
          "the create should have failed after the node call timed out",
        );
        const list = await env.client.list("?limit=5");
        const s = list[0];
        expect(s, "no session row");
        const ended = await env.client.waitFor(s.id, [...TERMINAL], 60_000);
        return `the session ended ${ended.status}/${ended.endReason}; ${await createsWork(env)}`;
      } finally {
        await setApiFailpoints("");
      }
    },
  },
  {
    id: "kill-gateway",
    name: "Kill the gateway",
    async run(env) {
      const [h] = await hold(env, 1);
      const url = h!.page.url();
      await h!.browser.close().catch(() => undefined);
      const node = (await containerOf(env, h!.session.id))?.node ?? "a";
      await crash(`kestrel-gateway-${node}-1`);
      await sleep(15_000);
      const s = await env.client.get(h!.session.id);
      expect(
        s.status === "ready" || s.status === "active",
        `the session is ${s.status} after the gateway was killed`,
      );
      const fresh = await env.client.get(h!.session.id);
      const browser = await until("a client to reconnect", 60_000, () =>
        chromium
          .connectOverCDP(fresh.connectUrl as string, { timeout: 15_000 })
          .catch(() => null),
      );
      const page = browser.contexts()[0]?.pages()[0];
      expect(page, "the default context has no page after reconnecting");
      const now = page.url();
      await browser.close().catch(() => undefined);
      await env.client.stop(h!.session.id);
      expect(now === url, `the page was ${now}, wanted ${url}`);
      return "the session survived and a new client found its page";
    },
  },
  {
    id: "slow-client",
    name: "A client stops reading",
    async run(env) {
      const [a] = await hold(env, 1);
      const node = (await containerOf(env, a!.session.id))?.node ?? "a";
      const port =
        env.host.nodes.find((n) => n.id === node)?.gatewayMetricsPort ?? 7201;
      const closes = async (): Promise<number> => {
        const text = await (
          await fetch(`http://127.0.0.1:${port}/metrics`)
        ).text();
        return Number(
          /kestrel_gateway_closes_total\{code="4009"\} (\d+)/.exec(text)?.[1] ??
            0,
        );
      };
      const before = await closes();
      const u = new URL(a!.session.connectUrl as string);
      const base = `wss://${u.host}${u.pathname}${u.search}`;
      const ws = new WebSocket(base, { perMessageDeflate: false });
      await new Promise<void>(
        (res, rej) => (ws.once("open", () => res()), ws.once("error", rej)),
      );
      ws.pause(); // it never reads again
      for (let i = 0; i < 6; i++)
        ws.send(
          JSON.stringify({
            id: i + 1,
            method: "Runtime.evaluate",
            params: { expression: "'x'.repeat(40e6)", returnByValue: true },
          }),
        );
      const neighbour = await neighbourWorks(env, 60_000);
      await until(
        "the gateway to close the slow client with 4009",
        90_000,
        async () => (await closes()) > before,
        2000,
      );
      ws.terminate();
      await a!.browser.close().catch(() => undefined);
      return `closed with 4009; ${neighbour}`;
    },
  },
  {
    id: "restart-egress",
    name: "Restart the egress gateway",
    async run(env) {
      const [h] = await hold(env, 1);
      await sh("docker restart kestrel-egress-a-1");
      await until(
        "sessions to reach the web again",
        40_000,
        async () => {
          try {
            await h!.page.goto(env.testPageUrl, { timeout: 8_000 });
            return (await h!.page.title()) === "Kestrel test page";
          } catch {
            return false;
          }
        },
        1500,
      );
      await release([h!], env.client);
      return "refused while it held no policies, then recovered once the agent restored them";
    },
  },
  {
    id: "restart-caddy",
    name: "Restart Caddy",
    async run(env) {
      const [h] = await hold(env, 1);
      await sh("docker restart kestrel-boot-caddy-1");
      const still = await usable(h!);
      await until(
        "HTTPS to come back",
        60_000,
        async () =>
          (
            await fetch(`https://${env.publicHostname}/healthz`).catch(
              () => null,
            )
          )?.ok,
      );
      await release([h!], env.client);
      expect(still, "a browser connection was affected by the Caddy restart");
      return "browser connection unaffected; HTTPS back";
    },
  },
  {
    id: "lose-node-b",
    name: "Stop node agent b past the lost threshold, then start it",
    async run(env) {
      const held: Held[] = [];
      const onB: Held[] = [];
      for (let i = 0; i < 6 && onB.length < 1; i++) {
        const h = (await hold(env, 1, { waitForCapacityMs: 5000 }))[0]!;
        held.push(h);
        if (h.session.nodeId === "b") onB.push(h);
      }
      expect(onB.length > 0, "no session landed on node b");
      await sh("docker stop kestrel-node-b-1");
      await sleep(45_000);
      const lost = await env.client.get(onB[0]!.session.id);
      expect(
        lost.status === "failed" && lost.endReason === "node_lost",
        `the session on node b is ${lost.status}/${lost.endReason}, wanted failed/node_lost`,
      );
      const placed = await env.client.create({});
      expect(
        placed.session.nodeId === "a",
        "a session was placed on the fenced node b",
      );
      await env.client.stop(placed.session.id);
      await sh("docker start kestrel-node-b-1");
      await until(
        "node b to take sessions again",
        90_000,
        async () => {
          const r = await env.client
            .create({ waitForCapacityMs: 1000 })
            .catch(() => null);
          if (!r) return false;
          await env.client.stop(r.session.id);
          return r.session.nodeId === "b";
        },
        3000,
      );
      await release(held, env.client);
      return "its session ended node_lost; capacity stayed fenced until it cleaned up and its fence lifted";
    },
  },
  {
    id: "restart-docker",
    name: "Restart the Docker daemon",
    async run(env) {
      const held = await hold(env, 2);
      const r = await sh(
        `docker run --rm --privileged --pid=host --entrypoint nsenter kestrel-platform:dev -t 1 -m -u -n -i systemctl restart docker`,
        {},
        180_000,
      );
      expect(r.code === 0, `could not restart Docker: ${r.out.slice(0, 160)}`);
      await until(
        "Docker to come back",
        90_000,
        async () => (await sh("docker ps -q")).code === 0,
        2000,
      );
      await sleep(15_000);
      const states = await Promise.all(
        held.map((h) => env.client.get(h.session.id)),
      );
      const ok = await Promise.all(held.map((h) => usable(h, 20_000)));
      await release(held, env.client);
      expect(
        states.every((s) => s.status === "ready" || s.status === "active"),
        "a session did not survive the Docker restart",
      );
      expect(
        ok.every(Boolean),
        "a session stopped answering after the Docker restart",
      );
      return "containers survived (live-restore); the firewall chains are checked by the invariants that follow";
    },
  },
];

export async function runChaos(
  env: ChaosEnv,
  opts: { only?: string[]; repeat?: number } = {},
): Promise<{ id: string; name: string; pass: boolean; detail: string }[]> {
  const results: { id: string; name: string; pass: boolean; detail: string }[] =
    [];
  const failpointsExpected = false;
  for (const c of CASES.filter((x) => !opts.only || opts.only.includes(x.id))) {
    for (let round = 1; round <= (opts.repeat ?? 1); round++) {
      const label = `${c.id}${(opts.repeat ?? 1) > 1 ? ` #${round}` : ""}`;
      env.log(`chaos: ${label}`);
      let detail: string;
      let pass = true;
      await sh(
        "docker start kestrel-postgres-1 kestrel-api-1 kestrel-egress-a-1 kestrel-node-a-1 kestrel-gateway-a-1 kestrel-egress-b-1 kestrel-node-b-1 kestrel-gateway-b-1 >/dev/null 2>&1",
      );
      await apiHealthy(env, 90_000).catch(() => undefined);
      try {
        detail = await c.run(env);
      } catch (e) {
        pass = false;
        detail = (e as Error).message;
      }
      await stopAll(env).catch(() => undefined);
      const inv = await settledInvariants(checkInvariants, env.host, {
        timeoutMs: 60_000,
        failpointsExpected,
      });
      if (!inv.ok) {
        pass = false;
        detail += `; INVARIANTS: ${inv.violations
          .slice(0, 4)
          .map((v) => `${v.rule}: ${v.detail}`)
          .join(" | ")}`;
      }
      results.push({ id: label, name: c.name, pass, detail });
      env.log(
        `chaos: ${label} ${pass ? "pass" : "FAIL"}: ${detail.slice(0, 200)}`,
      );
    }
  }
  return results;
}
