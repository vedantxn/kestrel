import {
  COMPUTER_LIMITS,
  type ComputerRequest,
  type ComputerResponse,
} from "@kestrel/contracts";
import { getVersion, Cdp } from "./cdp.js";

/**
 * W2, W4. Which page live view shows and `/computer` drives, and the input both send. Live view
 * and `/computer` share the choice, so an agent and the person watching it see the same tab.
 */
export interface TabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export class Tabs {
  /** The page chosen by a viewer, or null for "the first page". */
  current: string | null = null;

  async list(cdp: Cdp): Promise<TabInfo[]> {
    const { targetInfos } = await cdp.send<{
      targetInfos: {
        targetId: string;
        type: string;
        title: string;
        url: string;
      }[];
    }>("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    const chosen = this.pick(pages.map((p) => p.targetId));
    return pages.map((p) => ({
      id: p.targetId,
      title: p.title,
      url: p.url,
      active: p.targetId === chosen,
    }));
  }

  /** The chosen page if it still exists, otherwise the first. */
  pick(ids: string[]): string | null {
    if (this.current && ids.includes(this.current)) return this.current;
    return ids[0] ?? null;
  }
}

/** Connect to the browser's own endpoint (not through the forward) and attach to one page. */
export async function openPage(
  chromePort: number,
  tabs: Tabs,
): Promise<{ cdp: Cdp; page: PageDriver }> {
  const v = await getVersion(chromePort);
  const cdp = await Cdp.connect(v.wsUrl);
  try {
    const list = await tabs.list(cdp);
    const id = tabs.pick(list.map((t) => t.id));
    if (!id) throw new Error("the browser has no page");
    return { cdp, page: await PageDriver.attach(cdp, id) };
  } catch (e) {
    cdp.close();
    throw e;
  }
}

/** Named keys and what CDP needs to type them as a real keyboard would. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

export class PageDriver {
  private constructor(
    readonly cdp: Cdp,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  static async attach(cdp: Cdp, targetId: string): Promise<PageDriver> {
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    return new PageDriver(cdp, targetId, sessionId);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async detach(): Promise<void> {
    await this.cdp
      .send("Target.detachFromTarget", { sessionId: this.sessionId })
      .catch(() => undefined);
  }

  /** The page's size in CSS pixels and its URL. */
  async info(): Promise<{ width: number; height: number; url: string }> {
    const r = await this.send<{
      result: { value: { w: number; h: number; u: string } };
    }>("Runtime.evaluate", {
      expression: "({w: innerWidth, h: innerHeight, u: location.href})",
      returnByValue: true,
    });
    const v = r.result.value;
    return {
      width: Math.round(v.w),
      height: Math.round(v.h),
      url: String(v.u),
    };
  }

  async screenshot(): Promise<string> {
    const r = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      10_000,
    );
    return r.data;
  }

  async mouse(
    action: "down" | "up" | "move",
    x: number,
    y: number,
    button: "left" | "middle" | "right" = "left",
    clickCount = 1,
  ): Promise<void> {
    const type =
      action === "down"
        ? "mousePressed"
        : action === "up"
          ? "mouseReleased"
          : "mouseMoved";
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: action === "move" ? "none" : button,
      clickCount: action === "move" ? 0 : clickCount,
    });
  }

  async click(
    x: number,
    y: number,
    button: "left" | "middle" | "right" = "left",
    clicks = 1,
  ): Promise<void> {
    await this.mouse("move", x, y);
    for (let i = 1; i <= clicks; i++) {
      await this.mouse("down", x, y, button, i);
      await this.mouse("up", x, y, button, i);
    }
  }

  async wheel(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: dx,
      deltaY: dy,
    });
  }

  async text(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async key(key: string): Promise<void> {
    const k = KEYS[key];
    if (!k && [...key].length === 1) return this.text(key);
    if (!k) throw new Error(`unknown key ${JSON.stringify(key)}`);
    const base = {
      key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(k.text ? { text: k.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

/** W4. One `/computer` action, on the page live view would show. */
export async function runComputer(
  chromePort: number,
  tabs: Tabs,
  req: ComputerRequest,
): Promise<ComputerResponse> {
  const { cdp, page } = await openPage(chromePort, tabs);
  const timer = setTimeout(() => cdp.close(), COMPUTER_LIMITS.actionTimeoutMs);
  try {
    let shot = req.action === "screenshot";
    switch (req.action) {
      case "screenshot":
        break;
      case "click":
        await page.click(req.x, req.y, req.button, req.clicks);
        break;
      case "move":
        await page.mouse("move", req.x, req.y);
        break;
      case "scroll":
        await page.wheel(req.x, req.y, req.dx, req.dy);
        break;
      case "type":
        await page.text(req.text);
        break;
      case "key":
        await page.key(req.key);
        break;
    }
    if (req.action !== "screenshot" && req.screenshot) {
      shot = true;
      await new Promise((r) => setTimeout(r, 150)); // let the page paint what the action changed
    }
    const info = await page.info();
    return {
      ok: true,
      ...(shot ? { screenshot: await page.screenshot() } : {}),
      ...info,
    };
  } finally {
    clearTimeout(timer);
    await page.detach();
    cdp.close();
  }
}
