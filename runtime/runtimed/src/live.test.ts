import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LIVE_MODE_HEADER, PROOF_HEADER } from "@kestrel/contracts";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CdpForward } from "./forward.js";
import type { Detection } from "./captcha-match.js";
import { LiveServer, type CaptchaSource } from "./live.js";
import { Tabs, runComputer } from "./page.js";

/** A fake Chrome: discovery, two pages, and a screencast that sends a frame per acknowledgement. */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  calls: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  port = 0;
  maxFrames = 5;

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

  private serve(ws: WebSocket): void {
    let frames = 0;
    const frame = (sessionId: string) => {
      if (frames >= this.maxFrames) return;
      frames++;
      ws.send(
        JSON.stringify({
          method: "Page.screencastFrame",
          sessionId,
          params: {
            data: "AAAA",
            sessionId: frames,
            metadata: { deviceWidth: 1280, deviceHeight: 720 },
          },
        }),
      );
    };
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      this.calls.push({
        method: m.method,
        params: m.params,
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
      const reply = (result: object) =>
        ws.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case "Target.getTargets":
          return reply({
            targetInfos: [
              {
                targetId: "T1",
                type: "page",
                title: "One",
                url: "https://one.test/",
              },
              {
                targetId: "T2",
                type: "page",
                title: "Two",
                url: "https://two.test/",
              },
              { targetId: "W1", type: "service_worker", title: "", url: "" },
            ],
          });
        case "Target.attachToTarget":
          return reply({ sessionId: `S-${m.params.targetId as string}` });
        case "Runtime.evaluate":
          return reply({
            result: { value: { w: 1280, h: 720, u: "https://one.test/" } },
          });
        case "Page.captureScreenshot":
          return reply({ data: "PNGDATA" });
        case "Page.startScreencast":
          reply({});
          frames = 0;
          return frame(m.sessionId as string);
        case "Page.screencastFrameAck":
          reply({});
          return frame(m.sessionId as string);
        default:
          return reply({});
      }
    });
  }
}

const PROOF = "a".repeat(64);
let chrome: FakeChrome;
let forward: CdpForward;
let live: LiveServer;
let fport = 0;
const sockets: WebSocket[] = [];

async function setup(captcha?: CaptchaSource): Promise<void> {
  chrome = new FakeChrome();
  const cport = await chrome.start();
  live = new LiveServer(cport, new Tabs(), undefined, captcha);
  forward = new CdpForward(cport, live);
  forward.setProof(PROOF);
  fport = await forward.listen(0, "127.0.0.1");
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await live?.close();
  await forward?.close();
  await chrome?.stop();
});

function viewer(mode: "view" | "control", proof = PROOF): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${fport}/kestrel/live`, {
    headers: { [PROOF_HEADER]: proof, [LIVE_MODE_HEADER]: mode },
  });
  ws.on("error", () => undefined);
  sockets.push(ws);
  return ws;
}

function collect(ws: WebSocket): { type: string; [k: string]: unknown }[] {
  const out: { type: string; [k: string]: unknown }[] = [];
  ws.on("message", (d) => out.push(JSON.parse(d.toString())));
  return out;
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("live view in runtimed (W2)", () => {
  it("streams frames, acknowledging each, and lists the page tabs", async () => {
    await setup();
    const ws = viewer("view");
    const msgs = collect(ws);
    await until(() => msgs.filter((m) => m.type === "frame").length >= 5);
    const frame = msgs.find((m) => m.type === "frame");
    expect(frame).toMatchObject({ data: "AAAA", width: 1280, height: 720 });
    await until(() => msgs.some((m) => m.type === "tabs"));
    const tabs = msgs.find((m) => m.type === "tabs")!.tabs as {
      id: string;
      active: boolean;
    }[];
    expect(tabs.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(tabs[0]!.active).toBe(true);
    expect(
      chrome.calls.filter((c) => c.method === "Page.screencastFrameAck").length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("tells the viewer which CAPTCHAs are showing, at once and on every change", async () => {
    const listeners = new Set<(d: Detection[]) => void>();
    let now: Detection[] = [
      { provider: "recaptcha", host: "a.example" },
      { provider: "recaptcha", host: "b.example" },
    ];
    await setup({
      current: () => ({ detections: now }),
      onChange: (l) => (listeners.add(l), () => listeners.delete(l)),
    });
    const ws = viewer("view");
    const msgs = collect(ws);
    await until(() => msgs.some((m) => m.type === "captcha"));
    expect(msgs.find((m) => m.type === "captcha")).toEqual({
      type: "captcha",
      providers: ["recaptcha"],
    });
    now = [];
    for (const l of listeners) l(now);
    await until(() => msgs.filter((m) => m.type === "captcha").length === 2);
    expect(msgs.filter((m) => m.type === "captcha")[1]).toEqual({
      type: "captcha",
      providers: [],
    });
    ws.close();
    await until(() => listeners.size === 0);
  });

  it("sends no CAPTCHA messages without detection", async () => {
    await setup();
    const ws = viewer("view");
    const msgs = collect(ws);
    await until(() => msgs.some((m) => m.type === "tabs"));
    expect(msgs.some((m) => m.type === "captcha")).toBe(false);
  });

  it("ignores input on a view-only socket", async () => {
    await setup();
    const ws = viewer("view");
    const msgs = collect(ws);
    await until(() => msgs.some((m) => m.type === "frame"));
    ws.send(JSON.stringify({ type: "mouse", action: "down", x: 10, y: 10 }));
    ws.send(JSON.stringify({ type: "text", text: "hi" }));
    await until(() => live.ignoredInput === 2);
    expect(chrome.calls.some((c) => c.method.startsWith("Input."))).toBe(false);
  });

  it("sends a control socket's input to the page", async () => {
    await setup();
    const ws = viewer("control");
    const msgs = collect(ws);
    await until(() => msgs.some((m) => m.type === "frame"));
    ws.send(
      JSON.stringify({
        type: "mouse",
        action: "down",
        x: 10,
        y: 20,
        button: "left",
      }),
    );
    ws.send(JSON.stringify({ type: "key", key: "Enter" }));
    ws.send(JSON.stringify({ type: "text", text: "hello" }));
    ws.send("not json");
    await until(
      () =>
        chrome.calls.filter((c) => c.method.startsWith("Input.")).length >= 4,
    );
    const input = chrome.calls.filter((c) => c.method.startsWith("Input."));
    expect(input[0]).toMatchObject({
      method: "Input.dispatchMouseEvent",
      sessionId: "S-T1",
      params: { type: "mousePressed", x: 10, y: 20 },
    });
    expect(
      input.some(
        (c) =>
          c.method === "Input.dispatchKeyEvent" && c.params.key === "Enter",
      ),
    ).toBe(true);
    expect(
      input.some(
        (c) => c.method === "Input.insertText" && c.params.text === "hello",
      ),
    ).toBe(true);
  });

  it("switches tabs on request", async () => {
    await setup();
    const ws = viewer("view");
    const msgs = collect(ws);
    await until(() => msgs.some((m) => m.type === "frame"));
    ws.send(JSON.stringify({ type: "tab", id: "T2" }));
    await until(() =>
      chrome.calls.some(
        (c) => c.method === "Page.startScreencast" && c.sessionId === "S-T2",
      ),
    );
    expect(
      chrome.calls.some(
        (c) => c.method === "Page.stopScreencast" && c.sessionId === "S-T1",
      ),
    ).toBe(true);
  });

  it("still refuses a wrong proof before reaching the live module", async () => {
    await setup();
    const ws = viewer("view", "b".repeat(64));
    const err = await new Promise<string>((r) =>
      ws.once("unexpected-response", (_q, res) => r(String(res.statusCode))),
    );
    expect(err).toBe("403");
  });
});

describe("/computer in runtimed (W4)", () => {
  it("clicks, then returns the page size and a screenshot when asked", async () => {
    await setup();
    const r = await runComputer(chrome.port, new Tabs(), {
      action: "click",
      x: 5,
      y: 6,
      button: "left",
      clicks: 2,
      screenshot: true,
    });
    expect(r).toMatchObject({
      ok: true,
      width: 1280,
      height: 720,
      url: "https://one.test/",
      screenshot: "PNGDATA",
    });
    const presses = chrome.calls.filter(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        c.params.type === "mousePressed",
    );
    expect(presses.map((p) => p.params.clickCount)).toEqual([1, 2]);
  });

  it("acts on the tab a viewer chose", async () => {
    await setup();
    const tabs = new Tabs();
    tabs.current = "T2";
    await runComputer(chrome.port, tabs, {
      action: "type",
      text: "x",
      screenshot: false,
    });
    expect(
      chrome.calls.find((c) => c.method === "Input.insertText")?.sessionId,
    ).toBe("S-T2");
  });
});
