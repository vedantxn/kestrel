import type { Viewport } from "@kestrel/contracts";
import WebSocket from "ws";

/** A minimal CDP client: just enough to size the window and measure the page. */
class Cdp {
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
        };
        if (m.id === undefined) return;
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message ?? "CDP error"));
        else w.resolve(m.result);
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => this.failAll(new Error("CDP connection closed")));
    ws.on("error", () => this.failAll(new Error("CDP connection error")));
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        perMessageDeflate: false,
        handshakeTimeout: 5000,
        maxPayload: 8 * 1024 * 1024,
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

/**
 * A6. A caller asking for 1280x720 expects `innerWidth` and `innerHeight` to be exactly that. The
 * window is therefore made larger than the page by Chrome's own toolbar and borders, which are
 * measured on the live page (not assumed), and the result is measured again and corrected until
 * it is exact. Returns what the page actually reports, so the caller can verify it.
 */
export async function applyViewport(
  chromePort: number,
  want: Viewport,
): Promise<{
  viewport: Viewport;
  deviceScaleFactor: number;
  chromeVersion: string;
}> {
  const v = await getVersion(chromePort);
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
    let extraW = m.ow - m.iw;
    let extraH = m.oh - m.ih;
    for (let attempt = 0; attempt < 4; attempt++) {
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
      if (m.iw === want.width && m.ih === want.height) break;
      // Whatever happened, the overhead is what the page itself now says it is: measure it again rather
      // than accumulate corrections (a resize that was ignored must not skew the next attempt).
      extraW = m.ow - m.iw;
      extraH = m.oh - m.ih;
    }
    return {
      viewport: { width: m.iw, height: m.ih },
      deviceScaleFactor: m.dpr,
      chromeVersion: v.browser,
    };
  } finally {
    cdp.close();
  }
}
