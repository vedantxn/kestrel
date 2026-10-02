import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import type { Session } from "@kestrel/contracts";

export interface DriveResult {
  connectMs: number;
  navMs: number;
  title: string;
  innerWidth: number;
  innerHeight: number;
}

/**
 * What a script does with a session: connect to its `connectUrl`, load a page, read it back. An
 * interface so the lifecycle runner can be tested without a browser, and so Playwright and
 * Puppeteer (H1: both are goals) run the same lifecycle.
 */
export interface Driver {
  readonly name: string;
  drive(session: Session, pageUrl: string): Promise<DriveResult>;
}

const measure = `({ w: innerWidth, h: innerHeight, t: document.title })`;

/** Unmodified Playwright over CDP, through the supported `wss://` URL (C1). */
export class PlaywrightDriver implements Driver {
  readonly name: string = "playwright";

  constructor(
    private readonly opts: {
      connectUrl?: (s: Session) => string;
      timeoutMs?: number;
    } = {},
  ) {}

  async drive(session: Session, pageUrl: string): Promise<DriveResult> {
    if (!session.connectUrl) throw new Error("the session has no connectUrl");
    const t0 = performance.now();
    const browser = await chromium.connectOverCDP(
      this.opts.connectUrl?.(session) ?? session.connectUrl,
      { timeout: this.opts.timeoutMs ?? 30_000 },
    );
    try {
      const connectMs = performance.now() - t0;
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const t1 = performance.now();
      await page.goto(pageUrl, {
        waitUntil: "load",
        timeout: this.opts.timeoutMs ?? 30_000,
      });
      const navMs = performance.now() - t1;
      const m = (await page.evaluate(measure)) as {
        w: number;
        h: number;
        t: string;
      };
      return {
        connectMs,
        navMs,
        title: m.t,
        innerWidth: m.w,
        innerHeight: m.h,
      };
    } finally {
      // Close our connection, not the browser: the session is the API's to end.
      await browser.close().catch(() => undefined);
    }
  }
}

/** Playwright discovering over `https://` (C2): the `/json/version` form. */
export class PlaywrightDiscoveryDriver extends PlaywrightDriver {
  override readonly name = "playwright-discovery";
  constructor(timeoutMs?: number) {
    super({
      connectUrl: (s) => (s.connectUrl as string).replace(/^wss:/, "https:"),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }
}

/** Puppeteer: `wss://` only, since every released Puppeteer drops the path and query when it discovers (C2). */
export class PuppeteerDriver implements Driver {
  readonly name = "puppeteer";

  constructor(private readonly timeoutMs = 30_000) {}

  async drive(session: Session, pageUrl: string): Promise<DriveResult> {
    if (!session.connectUrl) throw new Error("the session has no connectUrl");
    const t0 = performance.now();
    const browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      protocolTimeout: this.timeoutMs,
    });
    try {
      const connectMs = performance.now() - t0;
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      const t1 = performance.now();
      await page.goto(pageUrl, { waitUntil: "load", timeout: this.timeoutMs });
      const navMs = performance.now() - t1;
      const m = (await page.evaluate(measure)) as {
        w: number;
        h: number;
        t: string;
      };
      return {
        connectMs,
        navMs,
        title: m.t,
        innerWidth: m.w,
        innerHeight: m.h,
      };
    } finally {
      await browser.disconnect().catch(() => undefined);
    }
  }
}
