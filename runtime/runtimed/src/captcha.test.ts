import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CaptchaWatcher, DISCOVER, LIST, MAX_TARGETS } from "./captcha.js";

const RC_ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&size=normal";

/** A fake Chrome: answers the target list from `targets`, and records every command. */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  calls: { method: string; params: unknown; sessionId?: string }[] = [];
  targets: object[] = [];
  port = 0;

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

  /** A target event: the watcher only takes it as a cue to read the list again. */
  nudge(): void {
    for (const c of this.wss.clients)
      c.send(
        JSON.stringify({
          method: "Target.targetInfoChanged",
          params: { targetInfo: { targetId: "x" } },
        }),
      );
  }

  drop(): void {
    for (const c of this.wss.clients) c.terminate();
  }

  private serve(ws: WebSocket): void {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params: unknown;
        sessionId?: string;
      };
      this.calls.push({
        method: m.method,
        params: m.params,
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
      const result =
        m.method === LIST.method ? { targetInfos: this.targets } : {};
      ws.send(JSON.stringify({ id: m.id, result }));
    });
  }
}

const page = (targetId: string, url: string, title = "t") => ({
  targetId,
  type: "page",
  url,
  title,
  attached: false,
});
const frame = (targetId: string, url: string, parentId: string) => ({
  targetId,
  type: "iframe",
  url,
  title: url,
  parentId,
  attached: false,
});

let chrome: FakeChrome;
let watcher: CaptchaWatcher;
afterEach(async () => {
  watcher?.close();
  await chrome?.stop();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(targets: object[] = [], refreshMs = 60_000) {
  chrome = new FakeChrome();
  chrome.targets = targets;
  const port = await chrome.start();
  watcher = new CaptchaWatcher(port, undefined, {
    settleMs: 5,
    reconnectMs: 50,
    refreshMs,
  });
  return watcher;
}

describe("the CAPTCHA watcher", () => {
  it("does nothing until started, then sends browser-level target commands and nothing else", async () => {
    const w = await setup([
      page("P1", "https://shop.example/"),
      frame("F1", RC_ANCHOR, "P1"),
    ]);
    expect(w.current()).toEqual({ watching: false, detections: [] });
    expect(chrome.calls).toEqual([]);
    w.start();
    w.start();
    await until(() => w.current().detections.length === 1);
    expect(w.current()).toEqual({
      watching: true,
      detections: [{ provider: "recaptcha", host: "shop.example" }],
    });
    chrome.nudge();
    await w.refresh();
    // T-53: never a command to a page, a domain enable or an attach.
    for (const c of chrome.calls) {
      expect([DISCOVER.method, LIST.method]).toContain(c.method);
      expect(c.sessionId).toBeUndefined();
    }
    expect(chrome.calls[0]).toEqual({
      method: DISCOVER.method,
      params: DISCOVER.params,
    });
  });

  it("follows the list as pages change, and tells listeners", async () => {
    const w = await setup([page("P1", "https://a.example/")]);
    const seen: string[][] = [];
    w.onChange((d) => seen.push(d.map((x) => x.provider)));
    w.start();
    await until(() => w.current().watching);
    chrome.targets = [
      page("P1", "https://a.example/"),
      frame("F1", RC_ANCHOR, "P1"),
    ];
    chrome.nudge();
    await until(() => w.current().detections.length === 1);
    chrome.targets = [
      page("P1", "https://a.example/", "Just a moment..."),
      frame("F1", RC_ANCHOR, "P1"),
    ];
    chrome.nudge();
    await until(() => w.current().detections.length === 2);
    chrome.targets = [page("P1", "https://a.example/next", "Next")];
    chrome.nudge();
    await until(() => w.current().detections.length === 0);
    expect(seen).toEqual([
      ["recaptcha"],
      ["recaptcha", "cloudflare_challenge"],
      [],
    ]);
  });

  it("notices frames that went without any event (a tab navigated away), on its next read", async () => {
    const w = await setup(
      [page("P1", "https://a.example/"), frame("F1", RC_ANCHOR, "P1")],
      50,
    );
    w.start();
    await until(() => w.current().detections.length === 1);
    // Chrome sent no targetDestroyed for F1; the periodic read finds it gone.
    chrome.targets = [page("P1", "https://a.example/plain")];
    await until(() => w.current().detections.length === 0);
  });

  it("ignores other target types and malformed infos", async () => {
    const w = await setup([
      page("P1", "https://a.example/"),
      { ...frame("W1", RC_ANCHOR, "P1"), type: "service_worker" },
      { type: "iframe", url: RC_ANCHOR },
      { targetId: 7, type: "iframe", url: RC_ANCHOR },
    ]);
    w.start();
    await until(() => w.current().watching);
    await w.refresh();
    expect(w.current().detections).toEqual([]);
  });

  it("considers at most MAX_TARGETS", async () => {
    const many: object[] = [];
    for (let i = 0; i < MAX_TARGETS + 50; i++)
      many.push(page(`P${i}`, `https://h${i}.example/`));
    many.push(frame("LATE", RC_ANCHOR, "P1"));
    const w = await setup(many);
    w.start();
    await until(() => w.current().watching);
    await w.refresh();
    expect(w.current().detections).toEqual([]);
  });

  it("says it is not watching when the connection drops, and reconnects when asked", async () => {
    const w = await setup([
      page("P1", "https://a.example/"),
      frame("F1", RC_ANCHOR, "P1"),
    ]);
    w.start();
    await until(() => w.current().detections.length === 1);
    chrome.drop();
    await until(() => !w.current().watching);
    expect(w.current().detections).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    await until(() => w.current().detections.length === 1);
    expect(
      chrome.calls.filter((c) => c.method === DISCOVER.method),
    ).toHaveLength(2);
  });

  it("gives up quietly when Chrome cannot be reached", async () => {
    chrome = new FakeChrome();
    await chrome.start();
    const port = chrome.port;
    await chrome.stop();
    watcher = new CaptchaWatcher(port, undefined, { reconnectMs: 50 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(watcher.current()).toEqual({ watching: false, detections: [] });
  });
});
