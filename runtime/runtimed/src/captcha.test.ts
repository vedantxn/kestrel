import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CaptchaWatcher, DISCOVER, MAX_TARGETS } from "./captcha.js";

const RC_ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&size=normal";

/** A fake Chrome that announces targets to whoever asks for discovery, and records every command. */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  calls: { method: string; params: unknown; sessionId?: string }[] = [];
  /** Targets announced on discovery. */
  initial: object[] = [];
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

  emit(method: string, params: object): void {
    for (const c of this.wss.clients)
      c.send(JSON.stringify({ method, params }));
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
      if (m.method === DISCOVER.method)
        for (const t of this.initial)
          ws.send(
            JSON.stringify({
              method: "Target.targetCreated",
              params: { targetInfo: t },
            }),
          );
      ws.send(JSON.stringify({ id: m.id, result: {} }));
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

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(initial: object[] = []) {
  chrome = new FakeChrome();
  chrome.initial = initial;
  const port = await chrome.start();
  watcher = new CaptchaWatcher(port, undefined, {
    settleMs: 5,
    reconnectMs: 50,
  });
  return watcher;
}

describe("the CAPTCHA watcher", () => {
  it("does nothing until started, then asks for discovery and nothing else", async () => {
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
    // T-53: one browser-level command, never a domain enable or an attach.
    expect(chrome.calls).toEqual([
      { method: DISCOVER.method, params: DISCOVER.params },
    ]);
  });

  it("follows targets as they appear, change and go, and tells listeners", async () => {
    const w = await setup([page("P1", "https://a.example/")]);
    const seen: string[][] = [];
    w.onChange((d) => seen.push(d.map((x) => x.provider)));
    w.start();
    await until(() => w.current().watching);
    chrome.emit("Target.targetCreated", {
      targetInfo: frame("F1", RC_ANCHOR, "P1"),
    });
    await until(() => w.current().detections.length === 1);
    chrome.emit("Target.targetInfoChanged", {
      targetInfo: page("P1", "https://a.example/", "Just a moment..."),
    });
    await until(() => w.current().detections.length === 2);
    chrome.emit("Target.targetDestroyed", { targetId: "F1" });
    chrome.emit("Target.targetInfoChanged", {
      targetInfo: page("P1", "https://a.example/next", "Next"),
    });
    await until(() => w.current().detections.length === 0);
    expect(seen).toEqual([
      ["recaptcha"],
      ["recaptcha", "cloudflare_challenge"],
      [],
    ]);
  });

  it("ignores other target types, session events and malformed infos", async () => {
    const w = await setup([page("P1", "https://a.example/")]);
    w.start();
    await until(() => w.current().watching);
    chrome.emit("Target.targetCreated", {
      targetInfo: { ...frame("W1", RC_ANCHOR, "P1"), type: "service_worker" },
    });
    chrome.emit("Target.targetCreated", { targetInfo: { type: "iframe" } });
    chrome.emit("Target.targetCreated", {
      targetInfo: { targetId: 7, type: "iframe", url: RC_ANCHOR },
    });
    for (const c of chrome.wss.clients)
      c.send(
        JSON.stringify({
          method: "Target.targetCreated",
          sessionId: "S",
          params: { targetInfo: frame("F9", RC_ANCHOR, "P1") },
        }),
      );
    await new Promise((r) => setTimeout(r, 50));
    w.flush();
    expect(w.current().detections).toEqual([]);
  });

  it("tracks at most MAX_TARGETS", async () => {
    const w = await setup();
    w.start();
    await until(() => w.current().watching);
    for (let i = 0; i < MAX_TARGETS + 50; i++)
      chrome.emit("Target.targetCreated", {
        targetInfo: page(`P${i}`, `https://h${i}.example/`),
      });
    chrome.emit("Target.targetCreated", {
      targetInfo: frame("LATE", RC_ANCHOR, "P1"),
    });
    await new Promise((r) => setTimeout(r, 200));
    w.flush();
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
    // The next question after the reconnect delay brings it back, with the targets re-announced.
    await new Promise((r) => setTimeout(r, 60));
    await until(() => w.current().detections.length === 1);
    expect(chrome.calls.map((c) => c.method)).toEqual([
      DISCOVER.method,
      DISCOVER.method,
    ]);
  });

  it("gives up quietly when Chrome cannot be reached, and tries again later", async () => {
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
