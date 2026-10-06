import type {
  RuntimeCaptcha,
  RuntimeCaptchaChallenge,
  RuntimeCaptchaInject,
} from "@kestrel/contracts";
import { Cdp, getVersion, type CdpEvent } from "./cdp.js";
import {
  MAX_TARGET_STRING,
  findChallenges,
  matchCaptchas,
  matchFrame,
  rootPageId,
  type Challenge,
  type Detection,
  type PageSignals,
  type TargetLite,
} from "./captcha-match.js";
import type { PageProber } from "./captcha-probe.js";

/** Targets considered at once; more are ignored (T-50). */
export const MAX_TARGETS = 1000;
/** A lost connection is retried at most this often, when the agent next asks. */
const RECONNECT_MS = 2000;
/** Events arrive in bursts as a page loads: refresh once they settle. */
const SETTLE_MS = 200;
/**
 * Chrome does not announce every iframe that goes: navigating a tab away from a page drops its
 * frames with no `targetDestroyed` (seen on Chrome 154). The list is therefore re-read on every
 * burst of events and at least this often.
 */
const REFRESH_MS = 2000;
const FILTER = [{ type: "page" }, { type: "iframe" }];
/** The commands this module sends, both at browser level: never to a page (T-53). */
export const DISCOVER = {
  method: "Target.setDiscoverTargets",
  params: { discover: true, filter: FILTER },
} as const;
export const LIST = {
  method: "Target.getTargets",
  params: { filter: FILTER },
} as const;

/**
 * CAPTCHA detection (`docs/lld/captcha.md`): one browser-level CDP connection that asks Chrome
 * which pages and iframes exist, and nothing else. No domain is enabled in any page. Events only
 * prompt a fresh read of the list, which is what is matched. With a `PageProber`, each read also
 * takes every page's frame tree and, where due, an isolated-world probe of its DOM, on the
 * prober's own connection (same-site frames and in-page widgets). Started at configure, so it
 * never runs in the pool or in a microVM template, and a snapshot copies no socket.
 */
export class CaptchaWatcher {
  private cdp: Cdp | null = null;
  private connecting: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private watching = false;
  private lastAttempt = 0;
  private detections: Detection[] = [];
  private settle: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private reading: Promise<void> | null = null;
  private again = false;
  private overflowLogged = false;
  private listeners = new Set<(d: Detection[]) => void>();
  private targets = new Map<string, TargetLite>();
  private pages = new Map<string, PageSignals>();
  private solving = false;

  constructor(
    private readonly chromePort: number,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly opts: {
      settleMs?: number;
      reconnectMs?: number;
      refreshMs?: number;
      /** Reads each page's frames and DOM (`captcha-probe.ts`); without it, targets only. */
      prober?: PageProber;
    } = {},
  ) {}

  /**
   * Begin watching; idempotent. Not awaited by configure. `solve`: this session solves, so the
   * probe also reads widgets' site keys and callbacks, and `challenges`/`inject` answer.
   */
  start(opts: { solve?: boolean } = {}): void {
    if (opts.solve) this.solving = true;
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }

  /** What is present now. A lost connection is retried here, lazily. */
  current(): RuntimeCaptcha {
    if (
      this.started &&
      !this.closed &&
      !this.cdp &&
      !this.connecting &&
      Date.now() - this.lastAttempt >= (this.opts.reconnectMs ?? RECONNECT_MS)
    )
      void this.connect();
    return {
      watching: this.watching,
      detections: this.watching ? [...this.detections] : [],
    };
  }

  /** Live view's banner. Returns an unsubscribe function. */
  onChange(l: (d: Detection[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Whether this session solves. */
  get solves(): boolean {
    return this.solving;
  }

  /** What a solver needs, for a session that solves: nothing otherwise. */
  challenges(): RuntimeCaptchaChallenge[] {
    if (!this.solving || !this.watching) return [];
    return findChallenges(this.targets, this.pages).map(
      ({ pageId: _page, ...c }) => c,
    );
  }

  /** Put a solver's token into the widget it was asked for, found afresh. */
  async inject(id: string, token: string): Promise<RuntimeCaptchaInject> {
    if (!this.solving || !this.opts.prober)
      return { result: "gone", callback: false };
    await this.refresh();
    const c: Challenge | undefined = findChallenges(
      this.targets,
      this.pages,
    ).find((x) => x.id === id);
    if (!c) return { result: "gone", callback: false };
    const r = await this.opts.prober.inject(
      c.pageId,
      c.provider,
      c.siteKey,
      token,
    );
    if (r.fields === 0 && !r.callback)
      return { result: "no_field", callback: false };
    return { result: "injected", callback: r.callback };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.settle);
    clearInterval(this.ticker);
    this.opts.prober?.close();
    this.cdp?.close();
    this.cdp = null;
    this.watching = false;
  }

  /** Read the list now and wait for it (tests). */
  async refresh(): Promise<void> {
    clearTimeout(this.settle);
    this.settle = undefined;
    if (this.reading) {
      this.again = true;
      await this.reading;
      if (!this.again) return;
    }
    this.again = false;
    this.reading = this.read().finally(() => {
      this.reading = null;
    });
    await this.reading;
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.lastAttempt = Date.now();
    this.connecting = (async () => {
      let cdp: Cdp | null = null;
      try {
        const { wsUrl } = await getVersion(this.chromePort);
        // Target infos are small; a page cannot make this connection buffer screenshots.
        cdp = await Cdp.connect(wsUrl, { maxPayload: 1024 * 1024 });
        if (this.closed) return cdp.close();
        const mine = cdp;
        cdp.onEvent((e) => this.onEvent(e));
        cdp.onClose(() => {
          if (this.cdp !== mine) return;
          this.cdp = null;
          this.watching = false;
          clearInterval(this.ticker);
          this.publish([]);
          this.log("captcha watch lost");
        });
        this.cdp = cdp;
        await cdp.send(DISCOVER.method, DISCOVER.params);
        this.watching = true;
        await this.refresh();
        clearInterval(this.ticker);
        this.ticker = setInterval(
          () => void this.refresh(),
          this.opts.refreshMs ?? REFRESH_MS,
        );
        this.ticker.unref?.();
      } catch (e) {
        this.log("captcha watch failed", {
          err: e instanceof Error ? e.message : String(e),
        });
        cdp?.close();
        if (this.cdp === cdp) this.cdp = null;
        this.watching = false;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private onEvent(e: CdpEvent): void {
    if (e.sessionId || !e.method.startsWith("Target.target")) return;
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      void this.refresh();
    }, this.opts.settleMs ?? SETTLE_MS);
    this.settle.unref?.();
  }

  /** Read Chrome's page and iframe targets and match them. */
  private async read(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || !this.watching) return;
    let infos: unknown;
    try {
      ({ targetInfos: infos } = await cdp.send<{ targetInfos: unknown }>(
        LIST.method,
        LIST.params,
      ));
    } catch {
      return; // the connection is going away; onClose reports it
    }
    if (!Array.isArray(infos)) return;
    // Cut just past the limit, so an oversized string still reads as oversized and matches nothing.
    const cut = (v: unknown) =>
      typeof v === "string" ? v.slice(0, MAX_TARGET_STRING + 1) : "";
    const targets = new Map<string, TargetLite>();
    for (const t of infos as Record<string, unknown>[]) {
      if (targets.size >= MAX_TARGETS) {
        if (!this.overflowLogged) this.log("captcha watch: too many targets");
        this.overflowLogged = true;
        break;
      }
      if (!t || typeof t.targetId !== "string") continue;
      if (t.type !== "page" && t.type !== "iframe") continue;
      targets.set(t.targetId.slice(0, 128), {
        type: t.type,
        url: cut(t.url),
        title: cut(t.title),
        parentId:
          typeof t.parentId === "string" ? t.parentId.slice(0, 128) : undefined,
      });
    }
    let pages = new Map<string, PageSignals>();
    if (this.opts.prober) {
      // Pages with a known frame are probed every read: a Cloudflare challenge page and a
      // Turnstile widget differ only inside the page, and a solve needs the widget's details.
      const framed = new Set<string>();
      const list: { id: string; url: string; title: string }[] = [];
      for (const [id, t] of targets) {
        if (t.type === "page") list.push({ id, url: t.url, title: t.title });
        else if (t.type === "iframe" && matchFrame(t.url)) {
          const root = rootPageId(targets, id);
          if (root) framed.add(root);
        }
      }
      pages = await this.opts.prober
        .read(list, { framed, widgets: this.solving })
        .catch(() => new Map<string, PageSignals>());
    }
    if (this.cdp === cdp && this.watching) {
      this.targets = targets;
      this.pages = pages;
      this.publish(matchCaptchas(targets, pages));
    }
  }

  private publish(next: Detection[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.detections)) return;
    this.detections = next;
    for (const l of this.listeners) l([...next]);
  }
}
