import type { RuntimeCaptcha } from "@kestrel/contracts";
import { Cdp, getVersion, type CdpEvent } from "./cdp.js";
import {
  MAX_TARGET_STRING,
  matchCaptchas,
  type Detection,
  type TargetLite,
} from "./captcha-match.js";

/** Targets tracked at once; more are ignored (T-50). */
export const MAX_TARGETS = 1000;
/** A lost connection is retried at most this often, when the agent next asks. */
const RECONNECT_MS = 2000;
/** Events arrive in bursts as a page loads: recompute once they settle. */
const SETTLE_MS = 200;
/** The only command this module ever sends, at browser level (T-53). */
export const DISCOVER = {
  method: "Target.setDiscoverTargets",
  params: { discover: true, filter: [{ type: "page" }, { type: "iframe" }] },
} as const;

/**
 * CAPTCHA detection (`docs/lld/captcha.md`): one browser-level CDP connection that asks Chrome to
 * announce page and iframe targets, and nothing else. No domain is enabled in any page and no
 * target is attached, so no page can tell it is there (HLD 8.10). Started at configure, so it
 * never runs in the pool or in a microVM template, and a snapshot copies no socket.
 */
export class CaptchaWatcher {
  private cdp: Cdp | null = null;
  private connecting: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private watching = false;
  private lastAttempt = 0;
  private targets = new Map<string, TargetLite>();
  private detections: Detection[] = [];
  private settle: NodeJS.Timeout | undefined;
  private overflowLogged = false;
  private listeners = new Set<(d: Detection[]) => void>();

  constructor(
    private readonly chromePort: number,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly opts: { settleMs?: number; reconnectMs?: number } = {},
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
    this.cdp?.close();
    this.cdp = null;
    this.watching = false;
  }

  /** Recompute now (tests). */
  flush(): void {
    clearTimeout(this.settle);
    this.settle = undefined;
    this.recompute();
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
        this.targets.clear();
        cdp.onEvent((e) => this.onEvent(e));
        cdp.onClose(() => {
          if (this.cdp !== mine) return;
          this.cdp = null;
          this.watching = false;
          this.targets.clear();
          this.flush();
          this.log("captcha watch lost");
        });
        this.cdp = cdp;
        // Chrome answers by announcing every existing page and iframe, then each change.
        await cdp.send(DISCOVER.method, DISCOVER.params);
        this.watching = true;
        this.flush();
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
    if (e.sessionId) return; // nothing is attached; nothing should arrive on a session
    if (e.method === "Target.targetDestroyed") {
      const id = e.params.targetId;
      if (typeof id === "string" && this.targets.delete(id.slice(0, 128)))
        this.changed();
      return;
    }
    if (
      e.method !== "Target.targetCreated" &&
      e.method !== "Target.targetInfoChanged"
    )
      return;
    const t = e.params.targetInfo as Record<string, unknown> | undefined;
    if (!t || typeof t.targetId !== "string") return;
    const type = t.type;
    if (type !== "page" && type !== "iframe") return;
    const id = t.targetId.slice(0, 128);
    if (!this.targets.has(id) && this.targets.size >= MAX_TARGETS) {
      if (!this.overflowLogged) this.log("captcha watch: too many targets");
      this.overflowLogged = true;
      return;
    }
    // Cut just past the limit, so an oversized string still reads as oversized and matches nothing.
    const cut = (v: unknown) =>
      typeof v === "string" ? v.slice(0, MAX_TARGET_STRING + 1) : "";
    this.targets.set(id, {
      type,
      url: cut(t.url),
      title: cut(t.title),
      parentId:
        typeof t.parentId === "string" ? t.parentId.slice(0, 128) : undefined,
    });
    this.changed();
  }

  private changed(): void {
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.recompute();
    }, this.opts.settleMs ?? SETTLE_MS);
    this.settle.unref?.();
  }

  private recompute(): void {
    const next = this.watching ? matchCaptchas(this.targets) : [];
    if (JSON.stringify(next) === JSON.stringify(this.detections)) return;
    this.detections = next;
    for (const l of this.listeners) l([...next]);
  }
}
