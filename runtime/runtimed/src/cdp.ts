import type { Viewport } from "@kestrel/contracts";
import WebSocket from "ws";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A minimal CDP client: enough to size the window, measure the page, and run live view (W2). */
export class Cdp {
  private listeners = new Set<(e: CdpEvent) => void>();
  private closeListeners = new Set<() => void>();
  private id = 0;
  private waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(d.toString()) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        if (m.id === undefined) {
          if (typeof m.method === "string")
            for (const l of this.listeners)
              l({
                method: m.method,
                params: m.params ?? {},
                ...(m.sessionId ? { sessionId: m.sessionId } : {}),
              });
          return;
        }
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message ?? "CDP error"));
        else w.resolve(m.result);
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => {
      this.failAll(new Error("CDP connection closed"));
      for (const l of this.closeListeners) l();
    });
    ws.on("error", () => this.failAll(new Error("CDP connection error")));
  }

  static connect(
    url: string,
    opts: { maxPayload?: number } = {},
  ): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        maxPayload: opts.maxPayload ?? 32 * 1024 * 1024, // screenshots
      });
      ws.once("open", () => resolve(new Cdp(ws)));
      ws.once("error", reject);
    });
  }

  private failAll(e: Error): void {
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeoutMs = 5000,
  ): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v as T)),
        reject: (e) => (clearTimeout(t), reject(e)),
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

  onEvent(l: (e: CdpEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onClose(l: () => void): void {
    this.closeListeners.add(l);
  }

  close(): void {
    this.ws.close();
  }
}

export async function getVersion(
  chromePort: number,
): Promise<{ browser: string; wsUrl: string }> {
  const res = await fetch(`http://127.0.0.1:${chromePort}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`json/version: ${res.status}`);
  const j = (await res.json()) as {
    Browser?: string;
    webSocketDebuggerUrl?: string;
  };
  if (
    typeof j.Browser !== "string" ||
    typeof j.webSocketDebuggerUrl !== "string"
  )
    throw new Error("json/version is malformed");
  return { browser: j.Browser, wsUrl: j.webSocketDebuggerUrl };
}

interface Measure {
  iw: number;
  ih: number;
  ow: number;
  oh: number;
  dpr: number;
}

const EXPR =
  "({iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio})";

export interface Applied {
  viewport: Viewport;
  deviceScaleFactor: number;
  chromeVersion: string;
  /** The whole window, toolbar included: what the recorder captures (W3). */
  window: { width: number; height: number };
}

/**
 * A6. A caller asking for 1280x720 expects `innerWidth` and `innerHeight` to be exactly that. The
 * window is therefore made larger than the page by Chrome's own toolbar and borders, which are
 * measured on the live page (not assumed), and the result is measured again and corrected until
 * it is exact. Returns what the page actually reports, so the caller can verify it.
 *
 * One sizer per browser keeps its CDP connection and page session between calls, so the window
 * can be sized to the default viewport while the browser warms in the pool, and a session start
 * that asks for that viewport costs one measurement instead of a connection, an attach, a resize
 * and its settling time. A lost connection or page is opened again on the next call.
 */
export class ViewportSizer {
  private conn: {
    cdp: Cdp;
    sessionId: string;
    windowId: number;
    version: string;
  } | null = null;

  constructor(private readonly chromePort: number) {}

  private async open(): Promise<NonNullable<ViewportSizer["conn"]>> {
    if (this.conn) return this.conn;
    const v = await getVersion(this.chromePort);
    const cdp = await Cdp.connect(v.wsUrl);
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: { targetId: string; type: string }[];
      }>("Target.getTargets");
      const page = targetInfos.find((t) => t.type === "page");
      if (!page) throw new Error("the browser has no page to size");
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
      );
      const { windowId } = await cdp.send<{ windowId: number }>(
        "Browser.getWindowForTarget",
        { targetId: page.targetId },
      );
      const conn = { cdp, sessionId, windowId, version: v.browser };
      cdp.onClose(() => {
        if (this.conn === conn) this.conn = null;
      });
      cdp.onEvent((e) => {
        // The page it sized went away (closed or crashed): attach afresh next time.
        if (
          e.method === "Target.detachedFromTarget" &&
          e.params.sessionId === sessionId
        )
          this.close();
      });
      this.conn = conn;
      return conn;
    } catch (e) {
      cdp.close();
      throw e;
    }
  }

  close(): void {
    const c = this.conn;
    this.conn = null;
    c?.cdp.close();
  }

  async apply(want: Viewport): Promise<Applied> {
    try {
      return await this.size(await this.open(), want);
    } catch (e) {
      // Whatever went wrong, the next call starts from a fresh connection.
      this.close();
      throw e;
    }
  }

  private async size(
    c: NonNullable<ViewportSizer["conn"]>,
    want: Viewport,
  ): Promise<Applied> {
    const { cdp, sessionId, windowId } = c;
    const measure = async (): Promise<Measure> => {
      const r = await cdp.send<{ result: { value: Measure } }>(
        "Runtime.evaluate",
        { expression: EXPR, returnByValue: true },
        sessionId,
      );
      const m = r.result.value;
      for (const k of ["iw", "ih", "ow", "oh", "dpr"] as const)
        if (!Number.isFinite(m[k]) || m[k] <= 0)
          throw new Error("the page reported an impossible size");
      return m;
    };

    let m = await measure();
    // Already the size asked for (sized while warming): nothing to do.
    for (
      let attempt = 0;
      attempt < 4 && !(m.iw === want.width && m.ih === want.height);
      attempt++
    ) {
      // The overhead is what the page itself says it is now: measured afresh each time rather than
      // corrections accumulated (a resize that was ignored must not skew the next attempt).
      const extraW = m.ow - m.iw;
      const extraH = m.oh - m.ih;
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 0,
          top: 0,
          width: want.width + extraW,
          height: want.height + extraH,
          windowState: "normal",
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      m = await measure();
    }
    return {
      viewport: { width: m.iw, height: m.ih },
      deviceScaleFactor: m.dpr,
      chromeVersion: c.version,
      window: { width: m.ow, height: m.oh },
    };
  }
}

/** Size once, on a connection of its own. */
export async function applyViewport(
  chromePort: number,
  want: Viewport,
): Promise<Applied> {
  const sizer = new ViewportSizer(chromePort);
  try {
    return await sizer.apply(want);
  } finally {
    sizer.close();
  }
}
