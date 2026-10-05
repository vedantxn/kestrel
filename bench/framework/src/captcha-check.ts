import WebSocket from "ws";
import type { CaptchaProvider, Session } from "@kestrel/contracts";
import { KestrelClient } from "./client.js";
import { m1ConfigFromEnv } from "./m1.js";
import { makeReport, type Report } from "./report.js";

/**
 * The CAPTCHA detection check (`docs/lld/captcha.md`), run on the host against the real
 * deployment, with real widgets from the providers on the S3 test site (official always-pass test
 * keys). Pages are driven with raw CDP only (attach and `Page.navigate`, no domain enabled), the
 * way a careful client would, and read back through the browser's target list.
 */
export interface CaptchaCheckConfig {
  apiUrl: string;
  apiKey: string;
  /** The test site's base, e.g. https://<bucket>.s3.us-east-1.amazonaws.com/test/captcha/ */
  pagesUrl: string;
  /** Nodes to cover; the first is the microVM node, where a recording session is also checked. */
  nodes: string[];
  environment: Record<string, string | number>;
  only?: number[];
  log: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw CDP connection to a session: no Playwright, so nothing enables a domain in any page. */
class RawCdp {
  private id = 0;
  private waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as { id?: number };
      if (m.id !== undefined) this.waiting.get(m.id)?.(m);
    });
  }
  static open(url: string): Promise<RawCdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once("open", () => resolve(new RawCdp(ws)));
      ws.once("error", reject);
    });
  }
  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        15_000,
      );
      this.waiting.set(id, (m) => {
        clearTimeout(t);
        this.waiting.delete(id);
        if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
        else resolve(m.result as T);
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  close(): void {
    this.ws.close();
  }
}

interface Held {
  label: string;
  session: Session;
  cdp: RawCdp;
  pageId: string;
  pageSession: string;
}

async function hold(session: Session, label: string): Promise<Held> {
  const cdp = await RawCdp.open(session.connectUrl as string);
  const { targetInfos } = await cdp.send<{
    targetInfos: { targetId: string; type: string }[];
  }>("Target.getTargets");
  const pageId = targetInfos.find((t) => t.type === "page")?.targetId;
  if (!pageId) throw new Error(`${label}: no page`);
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId: pageId, flatten: true },
  );
  return { label, session, cdp, pageId, pageSession: sessionId };
}

const navigate = (h: Held, url: string) =>
  h.cdp.send("Page.navigate", { url }, h.pageSession);

async function titleOf(h: Held): Promise<string> {
  const { targetInfos } = await h.cdp.send<{
    targetInfos: { targetId: string; title: string }[];
  }>("Target.getTargets");
  return targetInfos.find((t) => t.targetId === h.pageId)?.title ?? "";
}

async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | false>,
  every = 500,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(`${what} did not happen within ${ms / 1000} s`);
    await sleep(every);
  }
}

const providersOf = (s: Session): string =>
  (s.captcha?.providers ?? []).join(",");

export async function runCaptchaCheck(c: CaptchaCheckConfig): Promise<Report> {
  const client = new KestrelClient(c.apiUrl, c.apiKey, 120_000);
  const report = makeReport("captcha-check", c.environment);
  const want = (n: number) => !c.only || c.only.includes(n);
  const pageHost = new URL(c.pagesUrl).hostname;
  const page = (name: string) => new URL(`${name}.html`, c.pagesUrl).toString();
  const check = async (id: string, name: string, fn: () => Promise<string>) => {
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

  // One session per node, plus a recording session on the first (a Docker container on a
  // microVM node). Sessions that land elsewhere are stopped.
  const held: Held[] = [];
  const spare: Session[] = [];
  const get = (h: Held) => client.get(h.session.id);
  try {
    for (let i = 0; i < 12 && held.length < c.nodes.length; i++) {
      const { session } = await client.create({
        waitForCapacityMs: 30_000,
        idleTimeout: 600_000,
      });
      const node = session.nodeId ?? "?";
      if (
        c.nodes.includes(node) &&
        !held.some((h) => h.session.nodeId === node)
      )
        held.push(await hold(session, `node ${node}`));
      else spare.push(session);
    }
    for (let i = 0; i < 6; i++) {
      const { session } = await client.create({
        waitForCapacityMs: 30_000,
        idleTimeout: 600_000,
        recording: true,
      });
      if (session.nodeId === c.nodes[0]) {
        held.push(await hold(session, `node ${c.nodes[0]} (recording)`));
        break;
      }
      spare.push(session);
    }
    for (const s of spare) await client.stop(s.id).catch(() => undefined);
    const missing = c.nodes.filter(
      (n) => !held.some((h) => h.session.nodeId === n),
    );
    if (missing.length)
      throw new Error(`no session landed on ${missing.join(", ")}`);
    const latencies: number[] = [];

    if (want(1))
      await check(
        "1",
        "each provider's widget is detected on every node, with the page's host, and cleared when the page moves on",
        async () => {
          const out: string[] = [];
          const cases: [string, CaptchaProvider][] = [
            ["recaptcha", "recaptcha"],
            ["hcaptcha", "hcaptcha"],
            ["turnstile", "turnstile"],
            ["turnstile-interactive", "turnstile"],
            ["interstitial", "cloudflare_challenge"],
          ];
          for (const h of held) {
            for (const [name, provider] of cases) {
              const t0 = Date.now();
              await navigate(h, page(name));
              await until(
                `${h.label} ${name}: captcha ${provider}`,
                12_000,
                async () =>
                  providersOf(await get(h)) === provider ? true : false,
              );
              latencies.push(Date.now() - t0);
              if (name !== "interstitial") {
                const title = await titleOf(h);
                if (!title.includes("wd=false"))
                  throw new Error(
                    `${h.label} ${name}: title ${JSON.stringify(title)}`,
                  );
              }
              await navigate(h, page("plain"));
              await until(
                `${h.label} ${name}: captcha cleared`,
                12_000,
                async () => (await get(h)).captcha === null,
              );
            }
            const events = await client.eventList(h.session.id);
            const detected = events.filter(
              (e) => e.type === "captcha.detected",
            );
            const cleared = events.filter((e) => e.type === "captcha.cleared");
            const hosts = new Set(
              detected.map((e) => (e.data as { host: string | null }).host),
            );
            if (
              detected.length !== cases.length ||
              cleared.length !== cases.length
            )
              throw new Error(
                `${h.label}: ${detected.length} detected and ${cleared.length} cleared events, expected ${cases.length} each`,
              );
            if (hosts.size !== 1 || !hosts.has(pageHost))
              throw new Error(
                `${h.label}: hosts ${[...hosts].join(",")}, expected ${pageHost}`,
              );
            out.push(`${h.label}: ${cases.length} of ${cases.length}`);
          }
          latencies.sort((a, b) => a - b);
          const pct = (q: number) =>
            latencies[
              Math.min(latencies.length - 1, Math.floor(q * latencies.length))
            ];
          report.measure("detectMs", {
            p50: pct(0.5),
            p95: pct(0.95),
            max: latencies.at(-1),
            n: latencies.length,
          });
          return `${out.join("; ")}; navigation to detection p50 ${pct(0.5)} ms, max ${latencies.at(-1)} ms; navigator.webdriver false on every page`;
        },
      );

    if (want(2))
      await check("2", "invisible reCAPTCHA is not reported", async () => {
        const h = held[0]!;
        const captchaEvents = async () =>
          (await client.eventList(h.session.id)).filter((e) =>
            e.type.startsWith("captcha."),
          ).length;
        const before = await captchaEvents();
        await navigate(h, page("recaptcha-invisible"));
        await sleep(8_000);
        const s = await get(h);
        const added = (await captchaEvents()) - before;
        if (s.captcha !== null || added !== 0)
          throw new Error(
            `captcha ${JSON.stringify(s.captcha)}, ${added} new events`,
          );
        await navigate(h, page("plain"));
        return "no field and no event after 8 s";
      });

    if (want(3))
      await check(
        "3",
        "takeover: the live viewer is told, a person's click solves it, the field stays until the page moves on",
        async () => {
          const h = held[0]!;
          await navigate(h, page("recaptcha"));
          await until("captcha recaptcha", 12_000, async () =>
            providersOf(await get(h)) === "recaptcha" ? true : false,
          );
          const t = await client.mintToken(h.session.id, { scope: "control" });
          const frag = new URLSearchParams(new URL(t.url).hash.slice(1));
          const ws = new WebSocket(
            `${frag.get("ws")}?token=${encodeURIComponent(t.token)}`,
            {
              perMessageDeflate: false,
            },
          );
          const msgs: { type: string; providers?: string[] }[] = [];
          ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
          await new Promise<void>(
            (res, rej) => (ws.once("open", () => res()), ws.once("error", rej)),
          );
          try {
            const banner = await until(
              "a captcha message to the viewer",
              10_000,
              async () => msgs.find((m) => m.type === "captcha") ?? false,
            );
            if (banner.providers?.join() !== "recaptcha")
              throw new Error(`viewer was told ${JSON.stringify(banner)}`);
            await until("a frame", 10_000, async () =>
              msgs.some((m) => m.type === "frame"),
            );
            // The person clicks the checkbox in the viewer (page coordinates).
            for (const action of ["move", "down", "up"])
              ws.send(
                JSON.stringify({
                  type: "mouse",
                  action,
                  x: 68,
                  y: 79,
                  button: "left",
                }),
              );
            await until("the page reports solved", 15_000, async () =>
              (await titleOf(h)).includes("solved"),
            );
            await sleep(3_000);
            const still = await get(h);
            if (providersOf(still) !== "recaptcha")
              throw new Error(
                `after solving, captcha is ${JSON.stringify(still.captcha)}`,
              );
          } finally {
            ws.close();
          }
          await navigate(h, page("plain"));
          await until(
            "captcha cleared",
            12_000,
            async () => (await get(h)).captcha === null,
          );
          return "viewer told recaptcha; solved by a click through the control socket; still present while on the page (present is not unsolved); cleared after navigating away";
        },
      );

    if (want(4))
      await check(
        "4",
        "a flapping page stays within the event budget and ends cleared",
        async () => {
          const h = held[held.length > 1 ? 1 : 0]!;
          const start = Date.now();
          const count = async () =>
            (await client.eventList(h.session.id)).filter(
              (e) =>
                e.type.startsWith("captcha.") &&
                Date.parse(e.at) >= start - 1000,
            ).length;
          await navigate(h, page("flap"));
          await sleep(31_000);
          await until(
            "captcha cleared after the page stops flapping",
            30_000,
            async () => (await get(h)).captcha === null,
          );
          const elapsed = Date.now() - start;
          const n = await count();
          const bound = 6 + Math.ceil(elapsed / 10_000) * 2;
          if (n > bound)
            throw new Error(`${n} events in ${elapsed} ms, bound ${bound}`);
          await navigate(h, page("plain"));
          return `${h.label}: ${n} events over ${Math.round(elapsed / 1000)} s of a frame appearing and going every 300 ms (bound ${bound}); cleared at the end`;
        },
      );
  } finally {
    for (const h of held) {
      h.cdp.close();
      await client.stop(h.session.id).catch(() => undefined);
    }
  }
  return report.build();
}

export function captchaCheckConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): CaptchaCheckConfig {
  const base = m1ConfigFromEnv(env, log);
  const pages =
    env.CAPTCHA_PAGES_URL ?? new URL("captcha/", base.testPageUrl).toString();
  return {
    apiUrl: base.apiUrl,
    apiKey: base.apiKey,
    pagesUrl: pages,
    nodes: (env.NODES ?? "a,b").split(","),
    environment: base.environment,
    ...(env.ONLY ? { only: env.ONLY.split(",").map(Number) } : {}),
    log,
  };
}
