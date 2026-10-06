import { execFile } from "node:child_process";
import { request } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ProxyConfig, Session } from "@kestrel/contracts";
import { KestrelClient } from "./client.js";
import { m1ConfigFromEnv } from "./m1.js";
import { makeReport, type Report } from "./report.js";
import { SELF_HOST } from "./test-proxy.js";

/**
 * The upstream-proxy check (docs/lld/upstream-proxy.md), run on the host: sessions created with
 * `proxy` must exit from the test proxy's address (the runner's), on every node and over both
 * http and https; a wrong password, a blocked proxy address and an unreachable proxy must be
 * refused and reported, never answered from the host's own address; an egress gateway restart
 * must keep the proxy; and the password must appear nowhere it should not. Then the same for
 * SOCKS5 and TLS-to-the-proxy test proxies (checks 9, 10, when given), that each provider
 * adapter's credentials reach the proxy as documented (11), that pages, tabs and workers see the
 * session's time zone on every node (12), and that a known download is counted in the session's
 * usage (13, threat model G-20).
 */
export interface ProxyCheckConfig {
  apiUrl: string;
  apiKey: string;
  /** `http://<runner address>:<port>`, where the test proxy listens. */
  proxyServer: string;
  proxyUsername: string;
  proxyPassword: string;
  /** The runner's public address, which pages should see. */
  expectExitIp: string;
  /** The host's own public address, which a proxied session must never show. */
  hostIp: string;
  /** A proxy address nothing answers on (a port the runner's firewall drops). */
  unreachableProxy: string;
  /** `socks5://<runner>:<port>`: the test proxy in MODE=socks5, same credentials. Check 9. */
  socksProxyServer?: string | undefined;
  /** `https://<name>:<port>`: the test proxy in MODE=https with a certificate the gateway trusts. Check 10. */
  tlsProxyServer?: string | undefined;
  /** `https://<runner ip>:<port>`: a TLS test proxy whose certificate the gateway must refuse. Check 10. */
  untrustedTlsProxy?: string | undefined;
  nodes: string[];
  environment: Record<string, string | number>;
  only?: number[];
  log: (m: string) => void;
}

const CHECKIP = "checkip.amazonaws.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sh = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      cmd,
      args,
      { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } },
      (e, stdout, stderr) =>
        e
          ? reject(new Error(`${cmd}: ${stderr || e.message}`))
          : resolve(stdout + stderr),
    ),
  );

async function open(
  client: KestrelClient,
  proxy: ProxyConfig | undefined,
  extra: { timezone?: string } = {},
): Promise<{ session: Session; browser: Browser; page: Page }> {
  const { session } = await client.create({
    waitForCapacityMs: 30_000,
    ...(proxy ? { proxy } : {}),
    ...extra,
  });
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl as string, {
      timeout: 30_000,
    });
  } catch (e) {
    // Not handed back to a caller who would stop it: stop it here, so it does not run on.
    await client.stop(session.id).catch(() => undefined);
    throw e;
  }
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { session, browser, page };
}

async function close(
  client: KestrelClient,
  h: { session: Session; browser: Browser },
): Promise<void> {
  await h.browser.close().catch(() => undefined);
  await client.stop(h.session.id).catch(() => undefined);
}

/** The address a page sees, or the navigation error. */
async function exitIp(
  page: Page,
  scheme: "http" | "https",
  timeout = 20_000,
): Promise<{ ip: string } | { error: string }> {
  try {
    const res = await page.goto(`${scheme}://${CHECKIP}/`, { timeout });
    const text = ((await page.textContent("body")) ?? "").trim();
    if (!res || res.status() !== 200)
      return { error: `status ${res?.status()}: ${text.slice(0, 80)}` };
    return { ip: text };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0]!.slice(0, 160) };
  }
}

async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | false>,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(`${what} did not happen within ${ms / 1000} s`);
    await sleep(500);
  }
}

async function denial(
  client: KestrelClient,
  sessionId: string,
  reason: string,
  ms = 20_000,
): Promise<string> {
  return until(`an egress.denied event with ${reason}`, ms, async () => {
    const e = (await client.eventList(sessionId)).find(
      (x) =>
        x.type === "egress.denied" &&
        (x.data as { reason?: string }).reason === reason,
    );
    if (!e) return false;
    const d = e.data as { host: string; port: number };
    return `${reason} for ${d.host}:${d.port}`;
  });
}

const policies = (node: string) =>
  new Promise<string>((resolve, reject) => {
    const r = request(
      { socketPath: `/run/kestrel/${node}/egress.sock`, path: "/v1/policies" },
      (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve(t));
      },
    );
    r.on("error", reject);
    r.end();
  });

export async function runProxyCheck(c: ProxyCheckConfig): Promise<Report> {
  const client = new KestrelClient(c.apiUrl, c.apiKey, 120_000);
  const report = makeReport("upstream-proxy-check", c.environment);
  const want = (n: number) => !c.only || c.only.includes(n);
  const proxy = {
    server: c.proxyServer,
    username: c.proxyUsername,
    password: c.proxyPassword,
  };
  const wrongPassword = `wrong-${Math.random().toString(36).slice(2)}`;
  const check = async (
    id: string,
    name: string,
    fn: () => Promise<string>,
  ): Promise<void> => {
    c.log(`check ${id}: ${name}`);
    try {
      report.add({ id, name, pass: true, detail: await fn() });
    } catch (e) {
      report.add({
        id,
        name,
        pass: false,
        detail: (e as Error).message.slice(0, 600),
      });
    }
  };
  /** A failed navigation must never be followed by the host's address. */
  const neverTheHost = (
    r: { ip: string } | { error: string },
    what: string,
  ) => {
    if ("ip" in r && r.ip === c.hostIp)
      throw new Error(`${what} went out from the host's own address`);
  };

  if (want(1))
    await check(
      "1",
      "proxied sessions on every node exit from the proxy's address, over https and http; an unproxied one from the host's",
      async () => {
        const held: Awaited<ReturnType<typeof open>>[] = [];
        const seen: string[] = [];
        try {
          for (
            let i = 0;
            i < 12 && c.nodes.some((n) => !seen.includes(n));
            i++
          ) {
            const h = await open(client, proxy);
            held.push(h);
            const node = h.session.nodeId ?? "?";
            if (seen.includes(node)) continue;
            for (const scheme of ["https", "http"] as const) {
              const r = await exitIp(h.page, scheme);
              if (!("ip" in r))
                throw new Error(`node ${node} ${scheme}: ${r.error}`);
              if (r.ip !== c.expectExitIp)
                throw new Error(
                  `node ${node} ${scheme}: exit ${r.ip}, expected ${c.expectExitIp}`,
                );
            }
            seen.push(node);
          }
          const missing = c.nodes.filter((n) => !seen.includes(n));
          if (missing.length)
            throw new Error(
              `no proxied session landed on ${missing.join(", ")}`,
            );
          const plain = await open(client, undefined);
          held.push(plain);
          const r = await exitIp(plain.page, "https");
          if (!("ip" in r) || r.ip !== c.hostIp)
            throw new Error(
              `unproxied: ${JSON.stringify(r)}, expected ${c.hostIp}`,
            );
          return `nodes ${seen.join(", ")}: https and http exit ${c.expectExitIp}; unproxied exits ${c.hostIp}`;
        } finally {
          for (const h of held) await close(client, h);
        }
      },
    );

  if (want(2))
    await check(
      "2",
      "the session shows the proxy without its password",
      async () => {
        const { session } = await client.create({ proxy });
        try {
          const got = await client.get(session.id);
          for (const s of [session, got])
            if (JSON.stringify(s).includes(c.proxyPassword))
              throw new Error("the password is in a response");
          const p = got.options.proxy;
          if (
            p?.username !== c.proxyUsername ||
            !p.server.startsWith("http://")
          )
            throw new Error(`options.proxy is ${JSON.stringify(p)}`);
          return `options.proxy = ${JSON.stringify(p)}`;
        } finally {
          await client.stop(session.id).catch(() => undefined);
        }
      },
    );

  if (want(3))
    await check(
      "3",
      "a wrong password is refused and reported, and never answered from the host",
      async () => {
        const h = await open(client, { ...proxy, password: wrongPassword });
        try {
          const r = await exitIp(h.page, "https", 15_000);
          neverTheHost(r, "a wrong-password session");
          if ("ip" in r) throw new Error(`navigation succeeded: ${r.ip}`);
          const http = await exitIp(h.page, "http", 15_000);
          neverTheHost(http, "a wrong-password session over http");
          return `${r.error}; ${await denial(client, h.session.id, "upstream_auth_failed")}`;
        } finally {
          await close(client, h);
        }
      },
    );

  if (want(4))
    await check(
      "4",
      "a proxy at the metadata address or the host's own address is refused",
      async () => {
        const out: string[] = [];
        for (const server of [
          "http://169.254.169.254:80",
          `http://${c.hostIp}:${new URL(c.proxyServer).port}`,
        ]) {
          const h = await open(client, { server });
          try {
            const r = await exitIp(h.page, "https", 15_000);
            neverTheHost(r, `a session with proxy ${server}`);
            if ("ip" in r) throw new Error(`${server}: navigation succeeded`);
            out.push(
              `${server}: ${await denial(client, h.session.id, "upstream_blocked")}`,
            );
          } finally {
            await close(client, h);
          }
        }
        return out.join("; ");
      },
    );

  if (want(5))
    await check(
      "5",
      "an unreachable proxy is reported, and the page never loads from the host",
      async () => {
        const h = await open(client, { server: c.unreachableProxy });
        try {
          const r = await exitIp(h.page, "https", 30_000);
          neverTheHost(r, "an unreachable-proxy session");
          if ("ip" in r) throw new Error(`navigation succeeded: ${r.ip}`);
          return `${r.error}; ${await denial(client, h.session.id, "upstream_unreachable", 30_000)}`;
        } finally {
          await close(client, h);
        }
      },
    );

  if (want(6))
    await check(
      "6",
      "an egress gateway restart keeps the session's proxy",
      async () => {
        const h = await open(client, proxy);
        try {
          const node = h.session.nodeId as string;
          const before = await exitIp(h.page, "https");
          if (!("ip" in before) || before.ip !== c.expectExitIp)
            throw new Error(`before the restart: ${JSON.stringify(before)}`);
          await sh("docker", ["restart", `kestrel-egress-${node}-1`]);
          const seen: string[] = [];
          const end = Date.now() + 45_000;
          let ok = false;
          while (Date.now() < end) {
            const r = await exitIp(h.page, "https", 5_000);
            neverTheHost(r, "the session after the egress restart");
            seen.push("ip" in r ? r.ip : "error");
            if ("ip" in r && r.ip === c.expectExitIp) {
              ok = true;
              break;
            }
            await sleep(1_000);
          }
          if (!ok)
            throw new Error(
              `no answer through the proxy after the restart: ${seen.join(", ")}`,
            );
          return `node ${node}: after the restart ${seen.join(", ")}`;
        } finally {
          await close(client, h);
        }
      },
    );

  if (want(8))
    await check(
      "8",
      "a plain-HTTP page loads through the proxy (absolute-URI forwarding)",
      async () => {
        // Chrome upgrades http:// navigations to HTTPS where it can, so this uses a name only
        // the test proxy knows and answers over plain HTTP (SELF_HOST in test-proxy.ts).
        const h = await open(client, proxy);
        try {
          const res = await h.page.goto(`http://${SELF_HOST}/check?x=1`, {
            timeout: 30_000,
          });
          const text = ((await h.page.textContent("body")) ?? "").trim();
          if (
            !res ||
            res.status() !== 200 ||
            !text.startsWith("plain http via")
          )
            throw new Error(`status ${res?.status()}: ${text.slice(0, 120)}`);
          return text;
        } finally {
          await close(client, h);
        }
      },
    );

  /** A plain-HTTP page at the test proxy's own name: what the proxy saw (test-proxy.ts). */
  const who = async (page: Page): Promise<Record<string, unknown>> => {
    const res = await page.goto(`http://${SELF_HOST}/who`, { timeout: 30_000 });
    const text = ((await page.textContent("body")) ?? "").trim();
    if (!res || res.status() !== 200)
      throw new Error(`/who: status ${res?.status()}: ${text.slice(0, 120)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  /** Exit from the runner on every node, over https and http, through `server`. */
  const exitsEverywhere = async (
    p: ProxyConfig,
    via: string,
  ): Promise<string> => {
    const held: Awaited<ReturnType<typeof open>>[] = [];
    const seen: string[] = [];
    try {
      for (let i = 0; i < 12 && c.nodes.some((n) => !seen.includes(n)); i++) {
        const h = await open(client, p);
        held.push(h);
        const node = h.session.nodeId ?? "?";
        if (seen.includes(node)) continue;
        for (const scheme of ["https", "http"] as const) {
          const r = await exitIp(h.page, scheme);
          neverTheHost(r, `node ${node} over ${via}`);
          if (!("ip" in r) || r.ip !== c.expectExitIp)
            throw new Error(
              `node ${node} ${scheme}: ${JSON.stringify(r)}, expected ${c.expectExitIp}`,
            );
        }
        const w = await who(h.page);
        if (w.via !== via)
          throw new Error(`node ${node}: the proxy saw ${JSON.stringify(w)}`);
        seen.push(node);
      }
      const missing = c.nodes.filter((n) => !seen.includes(n));
      if (missing.length)
        throw new Error(`no session landed on ${missing.join(", ")}`);
      return `nodes ${seen.join(", ")}: https, http and plain-HTTP /who through ${via}`;
    } finally {
      for (const h of held) await close(client, h);
    }
  };

  if (want(9))
    await check(
      "9",
      "SOCKS5: sessions on every node exit from the proxy, a wrong password is refused and reported",
      async () => {
        if (!c.socksProxyServer) return "skipped: SOCKS_PROXY_SERVER not set";
        const socks = { ...proxy, server: c.socksProxyServer };
        const out = [await exitsEverywhere(socks, "socks5")];
        const h = await open(client, { ...socks, password: wrongPassword });
        try {
          const r = await exitIp(h.page, "https", 15_000);
          neverTheHost(r, "a wrong-password SOCKS5 session");
          if ("ip" in r) throw new Error(`navigation succeeded: ${r.ip}`);
          out.push(await denial(client, h.session.id, "upstream_auth_failed"));
        } finally {
          await close(client, h);
        }
        return out.join("; ");
      },
    );

  if (want(10))
    await check(
      "10",
      "TLS to the proxy: a trusted https:// proxy is used on every node; an untrusted one is refused, never bypassed",
      async () => {
        const out: string[] = [];
        if (c.tlsProxyServer)
          out.push(
            await exitsEverywhere(
              { ...proxy, server: c.tlsProxyServer },
              "https",
            ),
          );
        else out.push("trusted: skipped (TLS_PROXY_SERVER not set)");
        if (c.untrustedTlsProxy) {
          const h = await open(client, {
            ...proxy,
            server: c.untrustedTlsProxy,
          });
          try {
            const r = await exitIp(h.page, "https", 15_000);
            neverTheHost(r, "an untrusted-TLS-proxy session");
            if ("ip" in r) throw new Error(`navigation succeeded: ${r.ip}`);
            out.push(
              `untrusted: ${await denial(client, h.session.id, "upstream_tls_failed")}`,
            );
          } finally {
            await close(client, h);
          }
        } else out.push("untrusted: skipped (TLS_UNTRUSTED_PROXY not set)");
        return out.join("; ");
      },
    );

  if (want(11))
    await check(
      "11",
      "provider adapters: the proxy receives each provider's documented credential format",
      async () => {
        const out: string[] = [];
        for (const a of adapterCases(c.proxyUsername)) {
          const h = await open(client, {
            ...proxy,
            ...a.request,
            username: a.request.username ?? c.proxyUsername,
          });
          try {
            const w = await who(h.page);
            if (
              w.username !== a.username ||
              w.passwordExtra !== a.passwordExtra
            )
              throw new Error(
                `${a.provider}: the proxy saw ${JSON.stringify(w)}, expected ${JSON.stringify({ username: a.username, passwordExtra: a.passwordExtra })}`,
              );
            const shown = h.session.options.proxy;
            if (shown?.username !== (a.request.username ?? c.proxyUsername))
              throw new Error(
                `${a.provider}: options.proxy is ${JSON.stringify(shown)}`,
              );
            out.push(`${a.provider}: ${a.username}${a.passwordExtra}`);
          } finally {
            await close(client, h);
          }
        }
        return out.join("; ");
      },
    );

  if (want(12))
    await check(
      "12",
      "time zone: pages, new tabs and workers on every node see the exit country's zone, or the one asked for",
      async () => {
        const held: Awaited<ReturnType<typeof open>>[] = [];
        const seen: string[] = [];
        const out: string[] = [];
        try {
          for (
            let i = 0;
            i < 12 && c.nodes.some((n) => !seen.includes(n));
            i++
          ) {
            const h = await open(client, { ...proxy, country: "DE" });
            held.push(h);
            const node = h.session.nodeId ?? "?";
            if (seen.includes(node)) continue;
            if (h.session.options.timezone !== "Europe/Berlin")
              throw new Error(
                `node ${node}: options.timezone is ${h.session.options.timezone}`,
              );
            await who(h.page);
            const zones = await readZones(h.page);
            const tab = await h.page.context().newPage();
            await tab.goto(`http://${SELF_HOST}/who`, { timeout: 30_000 });
            zones.newTab = await tab.evaluate(
              () => Intl.DateTimeFormat().resolvedOptions().timeZone,
            );
            await tab.close();
            for (const [where, z] of Object.entries(zones))
              if (!sameZone(z, "Europe/Berlin"))
                throw new Error(`node ${node} ${where}: ${z}`);
            out.push(`node ${node}: ${JSON.stringify(zones)}`);
            seen.push(node);
          }
          const missing = c.nodes.filter((n) => !seen.includes(n));
          if (missing.length)
            throw new Error(`no session landed on ${missing.join(", ")}`);
          const t = await open(client, undefined, { timezone: "Asia/Tokyo" });
          held.push(t);
          const z = await t.page.evaluate(
            () => Intl.DateTimeFormat().resolvedOptions().timeZone,
          );
          if (!sameZone(z, "Asia/Tokyo"))
            throw new Error(`explicit Asia/Tokyo: the page sees ${z}`);
          out.push(`explicit, no proxy: ${z}`);
          return out.join("; ");
        } finally {
          for (const h of held) await close(client, h);
        }
      },
    );

  if (want(13))
    await check(
      "13",
      "byte counters: a known download is counted for its session, roughly, and reaches usage when it ends",
      async () => {
        const n = 5_000_000;
        const h = await open(client, proxy);
        try {
          await who(h.page);
          const got = await h.page.evaluate(
            async (size) =>
              (await (await fetch(`/bytes/${size}`)).arrayBuffer()).byteLength,
            n,
          );
          if (got !== n) throw new Error(`downloaded ${got} bytes, not ${n}`);
          // Some traffic through a tunnel too, so bytes go up as well as down.
          const r = await exitIp(h.page, "https");
          if (!("ip" in r)) throw new Error(`https: ${r.error}`);
        } finally {
          await close(client, h);
        }
        const ended = await client.waitFor(
          h.session.id,
          ["stopped", "failed", "timed_out"],
          30_000,
        );
        const verdict = bytesVerdict(ended.usage, n);
        if (verdict) throw new Error(verdict);
        return `downloaded ${n}; usage ${JSON.stringify(ended.usage)}`;
      },
    );

  if (want(7))
    await check(
      "7",
      "the password is in no log, row, listing or store",
      async () => {
        await sleep(5_000);
        const secrets = [c.proxyPassword, wrongPassword];
        const found: string[] = [];
        const scan = (where: string, text: string) => {
          for (const s of secrets) if (text.includes(s)) found.push(where);
        };
        const containers = (
          await sh("docker", [
            "ps",
            "--format",
            "{{.Names}}",
            "--filter",
            "name=kestrel-",
          ])
        )
          .split("\n")
          .filter((n) => /^kestrel-(api|egress|node|gateway)-/.test(n));
        for (const name of containers)
          scan(`${name} logs`, await sh("docker", ["logs", name]));
        scan(
          "postgres",
          await sh("docker", [
            "exec",
            "kestrel-postgres-1",
            "psql",
            "-U",
            "kestrel",
            "-d",
            "kestrel",
            "-tAc",
            "select options::text from sessions union all select request_hash from idempotency_keys union all select data::text from session_events",
          ]),
        );
        for (const node of c.nodes) {
          scan(`egress ${node} listing`, await policies(node));
          // Rows, by query: the write-ahead log may hold old pages until a checkpoint (T-45).
          scan(
            `node ${node} store`,
            await sh("docker", [
              "exec",
              "-w",
              "/app/apps/node",
              `kestrel-node-${node}-1`,
              "node",
              "-e",
              `const D=require("better-sqlite3");const d=new D("/var/lib/kestrel/${node}/store.db",{readonly:true});console.log(JSON.stringify(d.prepare("select * from sessions").all()))`,
            ]),
          );
        }
        if (found.length)
          throw new Error(`a password was found in: ${found.join(", ")}`);
        return `none in ${containers.length} containers' logs, Postgres, ${c.nodes.length} egress listings and node stores`;
      },
    );

  return report.build();
}

export function proxyCheckConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): ProxyCheckConfig {
  const base = m1ConfigFromEnv(env, log);
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required for the proxy check`);
    return v;
  };
  return {
    apiUrl: base.apiUrl,
    apiKey: base.apiKey,
    proxyServer: need("PROXY_SERVER"),
    proxyUsername: need("PROXY_USERNAME"),
    proxyPassword: need("PROXY_PASSWORD"),
    expectExitIp: need("EXPECT_EXIT_IP"),
    hostIp: need("PUBLIC_IP"),
    unreachableProxy: need("UNREACHABLE_PROXY"),
    socksProxyServer: env.SOCKS_PROXY_SERVER || undefined,
    tlsProxyServer: env.TLS_PROXY_SERVER || undefined,
    untrustedTlsProxy: env.TLS_UNTRUSTED_PROXY || undefined,
    nodes: (env.NODES ?? "a,b").split(","),
    environment: base.environment,
    ...(env.ONLY ? { only: env.ONLY.split(",").map(Number) } : {}),
    log,
  };
}

// --- helpers, unit-tested in proxy-check.test.ts -------------------------------------------------

/** The zones a page and a dedicated worker it starts see. */
async function readZones(page: Page): Promise<Record<string, string>> {
  return (await page.evaluate(`(async () => {
    const main = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const worker = await new Promise((resolve) => {
      const src = "postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = (e) => resolve(String(e.data));
      setTimeout(() => resolve("no answer from the worker"), 5000);
    });
    return { main, worker };
  })()`)) as Record<string, string>;
}

/**
 * Chrome's ICU may name a zone by an older alias (`Asia/Calcutta` for `Asia/Kolkata`): the same
 * zone either way.
 */
const ZONE_ALIASES: Record<string, string> = {
  "Asia/Kolkata": "Asia/Calcutta",
  "Europe/Kyiv": "Europe/Kiev",
  "Asia/Ho_Chi_Minh": "Asia/Saigon",
  "Asia/Kathmandu": "Asia/Katmandu",
};

export function sameZone(seen: string, want: string): boolean {
  const canon = (z: string): string => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions()
        .timeZone;
    } catch {
      return z;
    }
  };
  const a = ZONE_ALIASES[seen] ?? seen;
  const b = ZONE_ALIASES[want] ?? want;
  return seen === want || a === b || canon(a) === canon(b);
}

/**
 * What the egress gateway counted for a session that downloaded `n` bytes over plain HTTP and made
 * one HTTPS request: at least `n` down and at most 10% more plus 1 MB (heads, TLS, Chrome's own
 * requests), and something up. Null when it fits, else why not.
 */
export function bytesVerdict(
  usage: { egressBytesUp: number; egressBytesDown: number },
  n: number,
): string | null {
  const most = Math.round(n * 1.1) + 1_000_000;
  if (usage.egressBytesDown < n)
    return `egressBytesDown ${usage.egressBytesDown} is less than the ${n} downloaded`;
  if (usage.egressBytesDown > most)
    return `egressBytesDown ${usage.egressBytesDown} is more than ${most} for ${n} downloaded`;
  if (usage.egressBytesUp <= 0) return "egressBytesUp is 0";
  return null;
}

/**
 * One exit request per provider, and what the test proxy must receive for it, written out by
 * hand from each provider's documentation (the citations are in
 * packages/contracts/src/proxy-providers.ts). The test proxy accepts any username containing the
 * configured one, and a password that is the configured one or extends it with `_`.
 */
export function adapterCases(user: string): {
  provider: string;
  request: Partial<ProxyConfig>;
  username: string;
  passwordExtra: string;
}[] {
  return [
    {
      provider: "decodo",
      request: {
        provider: "decodo",
        country: "US",
        region: "texas",
        city: "austin",
        sticky: "bench1",
        stickyMinutes: 10,
      },
      username: `user-${user}-country-us-state-us_texas-city-austin-session-bench1-sessionduration-10`,
      passwordExtra: "",
    },
    {
      provider: "oxylabs",
      request: {
        provider: "oxylabs",
        country: "DE",
        city: "berlin",
        sticky: "bench2",
        stickyMinutes: 5,
      },
      username: `customer-${user}-cc-DE-city-berlin-sessid-bench2-sesstime-5`,
      passwordExtra: "",
    },
    {
      provider: "brightdata",
      request: {
        provider: "brightdata",
        username: `brd-customer-${user}-zone-bench`,
        country: "FR",
        city: "Paris",
        sticky: "bench3",
      },
      username: `brd-customer-${user}-zone-bench-country-fr-city-paris-session-bench3`,
      passwordExtra: "",
    },
    {
      provider: "iproyal",
      request: {
        provider: "iproyal",
        country: "GB",
        sticky: "bench004",
        stickyMinutes: 15,
      },
      username: user,
      passwordExtra: "_country-gb_session-bench004_lifetime-15m",
    },
  ];
}
