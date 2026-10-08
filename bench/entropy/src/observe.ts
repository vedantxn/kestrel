import { chromium, type Page } from "playwright-core";
import type { PageRandom, SessionObservation } from "./compare.js";
import type { HelloRecorder } from "./recorder.js";

/** Run in the page: what its scripts can read from the random sources, and its clock. */
async function probe(): Promise<PageRandom & { now: number }> {
  const hex = (b: ArrayBuffer | Uint8Array) =>
    Array.from(
      new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
  let ecdh: string | null = null;
  try {
    // Typed with Node's WebCrypto: this function runs in the page, where the same API exists.
    const k = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as { publicKey: Parameters<typeof crypto.subtle.exportKey>[1] };
    ecdh = hex(await crypto.subtle.exportKey("raw", k.publicKey));
  } catch {
    // WebCrypto needs a secure context; about:blank on some browsers is not one.
  }
  return {
    math: [Math.random(), Math.random(), Math.random(), Math.random()],
    grv: hex(crypto.getRandomValues(new Uint8Array(16))),
    uuid: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null,
    ecdh,
    now: Date.now(),
  };
}

async function measure(
  page: Page,
): Promise<{ random: PageRandom; skewMs: number }> {
  const t0 = Date.now();
  const { now, ...random } = await page.evaluate(probe);
  const t1 = Date.now();
  return { random, skewMs: now - (t0 + t1) / 2 };
}

export interface ObserveOptions {
  /** A page to load after the first one is read; null for none. */
  pageUrl: string | null;
  /**
   * A domain whose every subdomain reaches the recorder (`<anything>.1-2-3-4.sslip.io` does, for
   * 1.2.3.4); null skips the TLS check.
   */
  tls: { recorder: HelloRecorder; domain: string; port: number } | null;
  timeoutMs: number;
}

/** Attach to one browser over CDP and read what it shows of its random state. */
export async function observe(
  label: string,
  cdpUrl: string,
  index: number,
  opts: ObserveOptions,
): Promise<SessionObservation> {
  const browser = await chromium.connectOverCDP(cdpUrl, {
    timeout: opts.timeoutMs,
  });
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const first = await measure(page);
    let loaded: PageRandom | null = null;
    if (opts.pageUrl) {
      await page.goto(opts.pageUrl, { timeout: opts.timeoutMs });
      loaded = (await measure(page)).random;
    }
    let hellos: SessionObservation["hellos"] = [];
    if (opts.tls) {
      // Two connections, each to a name of this session's own, so the recorder can tell them apart.
      const prefix = `s${index}x${Math.random().toString(36).slice(2, 8)}`;
      for (const k of [0, 1]) {
        const port = opts.tls.port === 443 ? "" : `:${opts.tls.port}`;
        await page
          .goto(`https://${prefix}k${k}.${opts.tls.domain}${port}/`, {
            timeout: 15_000,
          })
          .catch(() => undefined); // the recorder never answers
      }
      for (let w = 0; w < 50 && opts.tls.recorder.for(prefix).length < 2; w++)
        await new Promise((r) => setTimeout(r, 100));
      hellos = opts.tls.recorder.for(prefix);
    }
    return {
      label,
      first: first.random,
      page: loaded,
      skewMs: first.skewMs,
      hellos,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
