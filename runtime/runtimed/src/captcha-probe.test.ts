import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CaptchaWatcher, DISCOVER, LIST } from "./captcha.js";
import {
  CALL_FUNCTION,
  FILL_FUNCTION,
  INJECT_COMMANDS,
  MAX_PROBED_PAGES,
  PROBE_COMMANDS,
  PageProber,
  probeExpression,
  readDom,
  readFrames,
} from "./captcha-probe.js";

const RC_ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&size=normal";
const HC_BASE =
  "https://newassets.hcaptcha.com/captcha/v1/0521/static/hcaptcha.html";

interface Call {
  conn: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/**
 * A fake Chrome for both connections: the target list, and per page its frames (as
 * `Page.getFrameTree` gives them, fragment apart) and what the probe would read.
 */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  calls: Call[] = [];
  targets: object[] = [];
  frames = new Map<string, { url: string; urlFragment?: string }[]>();
  dom = new Map<string, unknown>();
  /** Pages whose frame tree is too large for the probe's connection. */
  huge = new Set<string>();
  fill: unknown = { fields: 1, callback: "ok" };
  called: unknown = true;
  port = 0;
  private conns = 0;

  constructor() {
    this.server = createServer((req, res) => {
      if (req.url === "/json/version") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            Browser: "Chrome/154",
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/b`,
          }),
        );
      }
      res.writeHead(404).end();
    });
    this.server.on("upgrade", (req, socket, head) =>
      this.wss.handleUpgrade(req, socket, head, (ws) => this.serve(ws)),
    );
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private page(sessionId: string | undefined): string {
    return (sessionId ?? "").replace(/^S-/, "");
  }

  private answer(m: Call): unknown {
    const page = this.page(m.sessionId);
    switch (m.method) {
      case LIST.method:
        return { targetInfos: this.targets };
      case "Target.attachToTarget":
        return { sessionId: `S-${m.params.targetId as string}` };
      case "Page.getFrameTree":
        if (this.huge.has(page))
          return {
            frameTree: {
              frame: { id: page, url: "https://x/" },
              childFrames: [{ frame: { id: "c", url: "x".repeat(5 << 20) } }],
            },
          };
        return {
          frameTree: {
            frame: { id: page, url: "https://x/" },
            childFrames: (this.frames.get(page) ?? []).map((f, i) => ({
              frame: { id: `${page}-${i}`, ...f },
            })),
          },
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate":
        if (m.params.contextId === undefined)
          return { result: { type: "object", objectId: "G" } };
        return { result: { type: "object", value: this.dom.get(page) ?? {} } };
      case "Runtime.callFunctionOn":
        return {
          result: {
            value:
              m.params.executionContextId !== undefined
                ? this.fill
                : this.called,
          },
        };
      default:
        return {};
    }
  }

  private serve(ws: WebSocket): void {
    const conn = ++this.conns;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Call & { id: number };
      this.calls.push({
        conn,
        method: m.method,
        params: m.params ?? {},
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
      ws.send(JSON.stringify({ id: m.id, result: this.answer(m) }));
    });
  }
}

const page = (targetId: string, url: string, title = "t") => ({
  targetId,
  type: "page",
  url,
  title,
});
const frame = (targetId: string, url: string, parentId: string) => ({
  targetId,
  type: "iframe",
  url,
  title: url,
  parentId,
});

let chrome: FakeChrome;
let watcher: CaptchaWatcher | undefined;
let prober: PageProber | undefined;
afterEach(async () => {
  watcher?.close();
  prober?.close();
  watcher = undefined;
  prober = undefined;
  await chrome?.stop();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(targets: object[], clock?: { t: number }) {
  chrome = new FakeChrome();
  chrome.targets = targets;
  const port = await chrome.start();
  prober = new PageProber(port, undefined, clock ? { now: () => clock.t } : {});
  watcher = new CaptchaWatcher(port, undefined, {
    settleMs: 5,
    reconnectMs: 50,
    refreshMs: 60_000,
    prober,
  });
  return watcher;
}

const DOM = { cf: false, px: false, gt: false, aws: false };

describe("the page probe", () => {
  it("sends only its page commands, with no domain enabled and reads only in an isolated world", async () => {
    const w = await setup([
      page("P1", "https://www.google.com/recaptcha/api2/demo"),
      page("P2", "https://blocked.example/"),
      page("P3", "about:blank"),
    ]);
    chrome.frames.set("P1", [{ url: RC_ANCHOR }]);
    chrome.dom.set("P2", { ...DOM, px: true });
    w.start();
    await until(() => w.current().detections.length === 2);
    expect(w.current().detections).toEqual([
      { provider: "recaptcha", host: "www.google.com" },
      { provider: "perimeterx", host: "blocked.example" },
    ]);
    await w.refresh();
    const allowed = new Set<string>([
      DISCOVER.method,
      LIST.method,
      ...PROBE_COMMANDS,
    ]);
    for (const c of chrome.calls) {
      expect(allowed).toContain(c.method);
      expect(c.method).not.toMatch(/\.enable$/);
      if (c.method === "Runtime.evaluate") {
        expect(c.params.contextId).toBe(7);
        expect(c.params.expression).toBe(probeExpression(false));
      }
      if (c.method === "Target.attachToTarget")
        expect(c.params).toEqual({
          targetId: expect.any(String),
          flatten: true,
        });
      if (c.method === "Page.createIsolatedWorld")
        expect(c.params.grantUniveralAccess).toBe(false);
    }
    // The discovery connection still sends only the two browser-level commands (T-53).
    const discovery = chrome.calls.find(
      (c) => c.method === DISCOVER.method,
    )!.conn;
    for (const c of chrome.calls.filter((x) => x.conn === discovery)) {
      expect([DISCOVER.method, LIST.method]).toContain(c.method);
      expect(c.sessionId).toBeUndefined();
    }
    // Pages that are not http(s) are never attached.
    expect(
      chrome.calls.some(
        (c) =>
          c.method === "Target.attachToTarget" && c.params.targetId === "P3",
      ),
    ).toBe(false);
  });

  it("reads hCaptcha's fragment from the frame tree, which keeps it apart", async () => {
    const w = await setup([page("P1", "https://accounts.hcaptcha.com/demo")]);
    chrome.frames.set("P1", [
      {
        url: HC_BASE,
        urlFragment:
          "#frame=checkbox&sitekey=10000000-ffff-ffff-ffff-000000000001",
      },
      { url: HC_BASE, urlFragment: "#frame=challenge" },
    ]);
    w.start();
    await until(() => w.current().detections.length === 1);
    expect(w.current().detections).toEqual([
      { provider: "hcaptcha", host: "accounts.hcaptcha.com" },
    ]);
  });

  it("probes a page's DOM while it is young, then only every 10 s unless something is found", async () => {
    const clock = { t: 1_000_000 };
    const w = await setup([page("P1", "https://quiet.example/")], clock);
    w.start();
    await until(() => w.current().watching);
    const probes = () =>
      chrome.calls.filter((c) => c.method === "Runtime.evaluate").length;
    await w.refresh();
    const young = probes();
    expect(young).toBeGreaterThanOrEqual(2);
    clock.t += 11_000; // no longer young, and last probed just now
    await w.refresh();
    const settled = probes();
    await w.refresh();
    await w.refresh();
    expect(probes()).toBe(settled);
    expect(
      chrome.calls.filter((c) => c.method === "Page.getFrameTree").length,
    ).toBeGreaterThan(settled);
    clock.t += 10_000;
    await w.refresh();
    expect(probes()).toBe(settled + 1);
    // A widget found is checked at every read, so it clears promptly.
    chrome.dom.set("P1", { ...DOM, gt: true });
    clock.t += 10_000;
    await w.refresh();
    expect(w.current().detections).toEqual([
      { provider: "geetest", host: "quiet.example" },
    ]);
    chrome.dom.set("P1", DOM);
    await w.refresh();
    expect(w.current().detections).toEqual([]);
  });

  it("probes at most MAX_PROBED_PAGES pages and detaches from pages that went", async () => {
    const many = Array.from({ length: MAX_PROBED_PAGES + 5 }, (_, i) =>
      page(`P${i}`, `https://h${i}.example/`),
    );
    const w = await setup(many);
    w.start();
    await until(() => w.current().watching);
    await w.refresh();
    const attached = new Set(
      chrome.calls
        .filter((c) => c.method === "Target.attachToTarget")
        .map((c) => c.params.targetId),
    );
    expect(attached.size).toBe(MAX_PROBED_PAGES);
    chrome.targets = [page("P0", "https://h0.example/")];
    await w.refresh();
    await until(
      () =>
        chrome.calls.filter((c) => c.method === "Target.detachFromTarget")
          .length ===
        MAX_PROBED_PAGES - 1,
    );
  });

  it("leaves out for a while a page whose frame tree broke the connection, and carries on", async () => {
    const w = await setup([
      page("BIG", "https://big.example/"),
      page("P1", "https://blocked.example/"),
    ]);
    chrome.huge.add("BIG");
    chrome.dom.set("P1", { ...DOM, px: true });
    w.start();
    await until(() => w.current().watching);
    // The oversized answer closes the probe's connection and both pages become suspects; read
    // alone, BIG breaks it again and is left out, and P1 is fine. A few reads settle it.
    for (let i = 0; i < 20 && w.current().detections.length === 0; i++) {
      await w.refresh();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(w.current().detections).toEqual([
      { provider: "perimeterx", host: "blocked.example" },
    ]);
    const bigAttaches = () =>
      chrome.calls.filter(
        (c) =>
          c.method === "Target.attachToTarget" && c.params.targetId === "BIG",
      ).length;
    const n = bigAttaches();
    await w.refresh();
    await w.refresh();
    expect(bigAttaches()).toBe(n);
  });
});

describe("solving in runtimed", () => {
  it("gives no challenges and injects nothing unless the session solves", async () => {
    const w = await setup([
      page("P1", "https://shop.example/login?secret=1"),
      frame("F1", RC_ANCHOR, "P1"),
    ]);
    w.start();
    await until(() => w.current().detections.length === 1);
    expect(w.challenges()).toEqual([]);
    expect(await w.inject("0123456789abcdef", "tok")).toEqual({
      result: "gone",
      callback: false,
    });
    expect(
      chrome.calls.some((c) =>
        (INJECT_COMMANDS as readonly string[]).includes(c.method),
      ),
    ).toBe(false);
  });

  it("names each challenge without the page's query, and puts a token in with the widget's callback", async () => {
    const w = await setup([
      page("P1", "https://shop.example/login?secret=1"),
      frame("F1", RC_ANCHOR, "P1"),
    ]);
    chrome.dom.set("P1", {
      ...DOM,
      w: [
        {
          p: "recaptcha",
          k: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
          cb: "ok",
          s: null,
        },
      ],
    });
    w.start({ solve: true });
    await until(() => w.challenges().length === 1);
    const [c] = w.challenges();
    expect(c).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      provider: "recaptcha",
      siteKey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
      pageUrl: "https://shop.example/login",
      host: "shop.example",
      invisible: false,
    });
    expect(
      chrome.calls.find((x) => x.method === "Runtime.evaluate")?.params
        .expression,
    ).toBe(probeExpression(true));
    expect(await w.inject(c!.id, "03AF-token_1")).toEqual({
      result: "injected",
      callback: true,
    });
    const fill = chrome.calls.find(
      (x) =>
        x.method === "Runtime.callFunctionOn" &&
        x.params.executionContextId !== undefined,
    )!;
    expect(fill.params.functionDeclaration).toBe(FILL_FUNCTION);
    // Values, never source: the token cannot become code in either world.
    expect(fill.params.arguments).toEqual([
      { value: "recaptcha" },
      { value: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" },
      { value: "03AF-token_1" },
    ]);
    const call = chrome.calls.find(
      (x) => x.method === "Runtime.callFunctionOn" && x.params.objectId === "G",
    )!;
    expect(call.params.functionDeclaration).toBe(CALL_FUNCTION);
    expect(call.params.arguments).toEqual([
      { value: "ok" },
      { value: "recaptcha" },
      { value: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" },
      { value: "03AF-token_1" },
    ]);
    expect(
      chrome.calls.filter((x) => x.method === "Runtime.releaseObject"),
    ).toHaveLength(1);
    for (const x of chrome.calls) expect(x.method).not.toMatch(/\.enable$/);
  });

  it("says gone for a challenge no longer there, and no_field when the widget has nothing to fill", async () => {
    const w = await setup([
      page("P1", "https://shop.example/"),
      frame("F1", RC_ANCHOR, "P1"),
    ]);
    w.start({ solve: true });
    await until(() => w.challenges().length === 1);
    const id = w.challenges()[0]!.id;
    chrome.fill = { fields: 0, callback: null };
    chrome.called = false;
    expect(await w.inject(id, "tok")).toEqual({
      result: "no_field",
      callback: false,
    });
    chrome.targets = [page("P1", "https://shop.example/next")];
    expect(await w.inject(id, "tok")).toEqual({
      result: "gone",
      callback: false,
    });
  });
});

describe("reading the probe's answers", () => {
  it("keeps only the expected shapes from a renderer it does not trust", () => {
    expect(readDom(null)).toEqual({
      cloudflare: false,
      perimeterx: false,
      geetest: false,
      awsWaf: false,
      widgets: [],
    });
    const d = readDom({
      cf: "yes",
      px: true,
      gt: 1,
      aws: true,
      w: [
        { p: "recaptcha", k: "key-12345678", cb: "ok", s: "invisible" },
        { p: "evil", k: "x" },
        "junk",
        { p: "turnstile", k: 5, cb: "x".repeat(200), ac: "login", cd: "c" },
        ...Array.from({ length: 20 }, () => ({ p: "hcaptcha" })),
      ],
    });
    expect(d.cloudflare).toBe(false);
    expect(d.perimeterx).toBe(true);
    expect(d.geetest).toBe(false);
    expect(d.awsWaf).toBe(true);
    expect(d.widgets[0]).toEqual({
      provider: "recaptcha",
      siteKey: "key-12345678",
      callback: "ok",
      invisible: true,
    });
    expect(d.widgets[1]).toEqual({
      provider: "turnstile",
      siteKey: null,
      callback: null,
      invisible: false,
      action: "login",
      cdata: "c",
    });
    expect(d.widgets.length).toBeLessThanOrEqual(8);
  });

  it("bounds the frame tree it reads", () => {
    const deep = (n: number): object =>
      n === 0
        ? { frame: { id: "leaf", url: RC_ANCHOR } }
        : {
            frame: { id: `d${n}`, url: "https://x/" },
            childFrames: [deep(n - 1)],
          };
    expect(readFrames({ frameTree: deep(20) }).urls).toHaveLength(9);
    const wide = {
      frameTree: {
        frame: { id: "m", url: "https://x/" },
        childFrames: Array.from({ length: 500 }, () => ({
          frame: { url: "https://y/" },
        })),
      },
    };
    expect(readFrames(wide)).toEqual({
      main: "m",
      urls: Array.from({ length: 200 }, () => "https://y/"),
    });
    expect(readFrames(null)).toEqual({ main: null, urls: [] });
    expect(
      readFrames({
        frameTree: {
          frame: { id: "m" },
          childFrames: [
            { frame: { url: "x".repeat(3000) } },
            { frame: { url: 7 } },
          ],
        },
      }).urls,
    ).toEqual([""]);
  });
});
