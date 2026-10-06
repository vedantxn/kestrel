import { Cdp, getVersion, type CdpEvent } from "./cdp.js";

/** A lost connection (which takes Chrome's overrides with it) is made again this often. */
const RECONNECT_MS = 1000;
/** Child targets of a page: its out-of-process frames and its workers. */
const CHILDREN = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
};

/**
 * The only commands this module sends (HLD 8.10): no domain is enabled in any page.
 * `Target.setAutoAttach` at browser level for pages and in each page for its frames and workers,
 * `Emulation.setTimezoneOverride` in each page and out-of-process frame, and
 * `Runtime.runIfWaitingForDebugger` to let a new target start once its override is in place.
 */
export const TIMEZONE_COMMANDS = [
  "Target.setAutoAttach",
  "Emulation.setTimezoneOverride",
  "Runtime.runIfWaitingForDebugger",
] as const;

/**
 * The session's time zone (docs/lld/upstream-proxy.md). A pooled browser, or a microVM clone, was
 * launched before the session existed, so `TZ` cannot be set at launch; Chrome's own per-target
 * override is used instead, applied from one browser-level CDP connection held for the session's
 * life:
 *
 * - Every existing and new page is auto-attached, and new ones are held until the override is set
 *   (`waitForDebuggerOnStart`), so a page's first script already sees the zone. Each page in turn
 *   auto-attaches its out-of-process frames (each a renderer of its own, so each gets the
 *   override) and its workers, which share their renderer's zone.
 * - Nothing is enabled in a page: attaching is not visible to it, and no monitoring domain is
 *   turned on (HLD 8.10). The cost is a held start of one local round trip for each new target.
 * - Chrome drops an override when the connection that set it closes, so a lost connection is made
 *   again at once and the override set again.
 * - Chrome keeps one override per renderer: a client that sets its own (Playwright's
 *   `timezoneId`) on a page that has the session's gets "already in effect", which Playwright
 *   ignores, so the session's zone wins there.
 *
 * Service and shared workers are not covered: they are not children of a page.
 */
export class TimezoneOverride {
  private tz: string | null = null;
  private cdp: Cdp | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  /** Attach handlers in flight, so `apply` can wait for the pages that already exist. */
  private pending = new Set<Promise<void>>();
  /** Chrome refused the zone itself (its ICU does not know it). */
  private refused = false;

  constructor(
    private readonly chromePort: number,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly opts: { reconnectMs?: number } = {},
  ) {}

  /** The zone in force, or null. */
  current(): string | null {
    return this.cdp ? this.tz : null;
  }

  /**
   * Hold `tz` for every page from now on, and resolve once the pages that exist have it. A second
   * call with the same zone is a no-op; the session's zone is never changed.
   */
  async apply(tz: string): Promise<void> {
    if (this.tz !== null && this.tz !== tz)
      throw new Error("this browser already has another time zone");
    this.tz = tz;
    if (!this.cdp) await this.connect(true);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.cdp?.close();
    this.cdp = null;
  }

  private connect(strict: boolean): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let cdp: Cdp | null = null;
      try {
        const { wsUrl } = await getVersion(this.chromePort);
        cdp = await Cdp.connect(wsUrl, { maxPayload: 1024 * 1024 });
        if (this.closed) return cdp.close();
        const mine = cdp;
        cdp.onEvent((e) => this.onEvent(mine, e));
        cdp.onClose(() => {
          if (this.cdp !== mine) return;
          this.cdp = null;
          this.log("time zone connection lost; reconnecting");
          this.scheduleReconnect();
        });
        this.cdp = cdp;
        // Chrome announces the pages that exist before it answers.
        await cdp.send("Target.setAutoAttach", {
          ...CHILDREN,
          filter: [{ type: "page" }],
        });
        await this.settled();
        if (this.refused)
          throw new Error(`Chrome refused the time zone ${this.tz}`);
      } catch (e) {
        cdp?.close();
        if (this.cdp === cdp) this.cdp = null;
        this.log("time zone override failed", {
          err: e instanceof Error ? e.message : String(e),
        });
        if (strict) throw e;
        this.scheduleReconnect();
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.tz === null) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => void this.connect(false),
      this.opts.reconnectMs ?? RECONNECT_MS,
    );
    this.retry.unref?.();
  }

  /** Wait for every attach handler in flight, including those started while waiting. */
  private async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private onEvent(cdp: Cdp, e: CdpEvent): void {
    if (e.method !== "Target.attachedToTarget") return;
    const sessionId = e.params.sessionId;
    const info = e.params.targetInfo as { type?: unknown } | undefined;
    if (typeof sessionId !== "string" || !info) return;
    const p = this.onAttached(
      cdp,
      sessionId,
      String(info.type),
      e.params.waitingForDebugger === true,
    ).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async onAttached(
    cdp: Cdp,
    sessionId: string,
    type: string,
    waiting: boolean,
  ): Promise<void> {
    try {
      if ((type === "page" || type === "iframe") && this.tz) {
        await cdp
          .send(
            "Emulation.setTimezoneOverride",
            { timezoneId: this.tz },
            sessionId,
          )
          .catch((err: Error) => {
            // A client's own override came first in this renderer; a target that went away.
            if (!/already in effect|not found|No target/i.test(err.message))
              throw err;
          });
        await cdp
          .send("Target.setAutoAttach", CHILDREN, sessionId)
          .catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof Error && /invalid timezone/i.test(err.message))
        this.refused = true;
      this.log("time zone override refused", {
        type,
        err: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    } finally {
      // Never leave a target held: whatever happened above, let it run.
      if (waiting)
        await cdp
          .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
          .catch(() => undefined);
    }
  }
}
