import type { RuntimeCaptcha } from "@kestrel/contracts";
import { Cdp, getVersion, type CdpEvent } from "./cdp.js";
import {
  MAX_TARGET_STRING,
  matchCaptchas,
  type Detection,
  type TargetLite,
} from "./captcha-match.js";

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
 * which pages and iframes exist, and nothing else. No domain is enabled in any page and no target
 * is attached, so no page can tell it is there (HLD 8.10). Events only prompt a fresh read of the
 * list, which is what is matched. Started at configure, so it never runs in the pool or in a
 * microVM template, and a snapshot copies no socket.
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

  constructor(
    private readonly chromePort: number,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly opts: {
      settleMs?: number;
      reconnectMs?: number;
      refreshMs?: number;
    } = {},
  ) {}

  /** Begin watching; idempotent. Not awaited by configure. */
  start(): void {
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

  close(): void {
    this.closed = true;
    clearTimeout(this.settle);
    clearInterval(this.ticker);
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
    if (this.cdp === cdp && this.watching) this.publish(matchCaptchas(targets));
  }

  private publish(next: Detection[]): void {
    if (JSON.stringify(next) === JSON.stringify(this.detections)) return;
    this.detections = next;
    for (const l of this.listeners) l([...next]);
  }
}
