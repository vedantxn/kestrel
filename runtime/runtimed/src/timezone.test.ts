import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Cdp, getVersion } from "./cdp.js";
import { TIMEZONE_COMMANDS, TimezoneOverride } from "./timezone.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/**
 * A fake Chrome: browser-level auto-attach announces `pages` (existing ones not waiting), each
 * command is recorded and answered, and `invalid` zones are refused as Chrome refuses them.
 */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  calls: Call[] = [];
  pages = ["p1"];
  invalid = new Set(["Mars/Olympus"]);
  port = 0;
  private n = 0;

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

  drop(): void {
    for (const c of this.wss.clients) c.terminate();
  }

  /** A new target appears, held until the client lets it run. */
  open(type: string, parentSessionId?: string): string {
    const sessionId = `s${++this.n}`;
    for (const c of this.wss.clients)
      c.send(
        JSON.stringify({
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: { targetId: `t${this.n}`, type, url: "" },
            waitingForDebugger: true,
          },
          ...(parentSessionId ? { sessionId: parentSessionId } : {}),
        }),
      );
    return sessionId;
  }

  private serve(ws: WebSocket): void {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Call & { id: number };
      this.calls.push({
        method: m.method,
        params: m.params,
        ...(m.sessionId ? { sessionId: m.sessionId } : {}),
      });
      if (
        m.method === "Emulation.setTimezoneOverride" &&
        this.invalid.has(m.params.timezoneId as string)
      )
        return ws.send(
          JSON.stringify({
            id: m.id,
            error: { code: -32000, message: "Invalid timezone ID" },
          }),
        );
      if (m.method === "Target.setAutoAttach" && !m.sessionId)
        for (const p of this.pages)
          ws.send(
            JSON.stringify({
              method: "Target.attachedToTarget",
              params: {
                sessionId: `existing-${p}`,
                targetInfo: { targetId: p, type: "page", url: "about:blank" },
                waitingForDebugger: false,
              },
            }),
          );
      ws.send(JSON.stringify({ id: m.id, result: {} }));
    });
  }
}

let chrome: FakeChrome;
let tz: TimezoneOverride | undefined;
afterEach(async () => {
  tz?.close();
  await chrome?.stop();
});
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the session's time zone in runtimed", () => {
  it("is set in every existing page before apply resolves, and in every new page before it runs", async () => {
    chrome = new FakeChrome();
    chrome.pages = ["p1", "p2"];
    tz = new TimezoneOverride(await chrome.start());
    await tz.apply("Asia/Tokyo");
    expect(tz.current()).toBe("Asia/Tokyo");
    for (const p of ["p1", "p2"])
      expect(chrome.calls).toContainEqual({
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: "Asia/Tokyo" },
        sessionId: `existing-${p}`,
      });

    const s = chrome.open("page");
    await waitFor(() =>
      chrome.calls.some(
        (c) =>
          c.method === "Runtime.runIfWaitingForDebugger" && c.sessionId === s,
      ),
    );
    const forS = chrome.calls
      .filter((c) => c.sessionId === s)
      .map((c) => c.method);
    // The override first, then its frames and workers, and only then may the page run.
    expect(forS).toEqual([
      "Emulation.setTimezoneOverride",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });

  it("reaches out-of-process frames, and lets workers run without touching them", async () => {
    chrome = new FakeChrome();
    tz = new TimezoneOverride(await chrome.start());
    await tz.apply("Europe/Berlin");
    const frame = chrome.open("iframe", "existing-p1");
    const worker = chrome.open("worker", "existing-p1");
    await waitFor(
      () =>
        chrome.calls.filter(
          (c) => c.method === "Runtime.runIfWaitingForDebugger",
        ).length === 2,
    );
    expect(
      chrome.calls.find(
        (c) =>
          c.sessionId === frame && c.method === "Emulation.setTimezoneOverride",
      ),
    ).toBeDefined();
    expect(
      chrome.calls.filter((c) => c.sessionId === worker).map((c) => c.method),
    ).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  it("sends nothing but its three commands, and enables no domain (HLD 8.10)", async () => {
    chrome = new FakeChrome();
    tz = new TimezoneOverride(await chrome.start());
    await tz.apply("Asia/Tokyo");
    chrome.open("page");
    chrome.open("iframe", "existing-p1");
    await waitFor(
      () =>
        chrome.calls.filter(
          (c) => c.method === "Runtime.runIfWaitingForDebugger",
        ).length === 2,
    );
    for (const c of chrome.calls)
      expect(TIMEZONE_COMMANDS as readonly string[]).toContain(c.method);
    expect(chrome.calls.some((c) => c.method.endsWith(".enable"))).toBe(false);
  });

  it("fails apply when Chrome refuses the zone, and never leaves a target held", async () => {
    chrome = new FakeChrome();
    tz = new TimezoneOverride(await chrome.start());
    await expect(tz.apply("Mars/Olympus")).rejects.toThrow(/refused/);
    expect(tz.current()).toBeNull();
  });

  it("refuses to change a session's zone", async () => {
    chrome = new FakeChrome();
    tz = new TimezoneOverride(await chrome.start());
    await tz.apply("Asia/Tokyo");
    await tz.apply("Asia/Tokyo");
    await expect(tz.apply("Europe/Paris")).rejects.toThrow(/another/);
  });

  it("connects again after losing Chrome, and sets the zone again (Chrome dropped it)", async () => {
    chrome = new FakeChrome();
    tz = new TimezoneOverride(await chrome.start(), () => undefined, {
      reconnectMs: 20,
    });
    await tz.apply("Asia/Tokyo");
    const before = chrome.calls.filter(
      (c) => c.method === "Emulation.setTimezoneOverride",
    ).length;
    chrome.drop();
    await waitFor(
      () =>
        chrome.calls.filter((c) => c.method === "Emulation.setTimezoneOverride")
          .length > before,
    );
    await waitFor(() => tz!.current() === "Asia/Tokyo");
  });
});

/*
 * Against a real Chrome, when one is named: KESTREL_TEST_CHROME=/path/to/chrome. A page created
 * by another client (as Playwright would) reads the zone from its first script, in its workers,
 * and in an out-of-process frame.
 */
const CHROME = process.env.KESTREL_TEST_CHROME;
describe.skipIf(!CHROME)("against a real Chrome", () => {
  let proc: ChildProcess | undefined;
  let site: Server | undefined;
  afterEach(async () => {
    proc?.kill();
    site?.closeAllConnections();
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
  });

  it("every page, frame and worker sees the session's zone", async () => {
    let framePort = 0;
    site = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/frame")
        return res.end(
          `<script>parent.postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone, "*")</script>`,
        );
      res.end(`<script>
        window.first = Intl.DateTimeFormat().resolvedOptions().timeZone;
        window.offset = new Date(2026, 0, 15).getTimezoneOffset();
        new Worker(URL.createObjectURL(new Blob(["postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)"]))).onmessage = (e) => (window.worker = e.data);
        addEventListener("message", (e) => (window.frame = e.data));
      </script><iframe src="http://localhost:${framePort}/frame"></iframe>`);
    });
    await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
    const port = (site.address() as AddressInfo).port;
    framePort = port; // localhost and 127.0.0.1 are different sites: an out-of-process frame
    const debugPort = 19_000 + Math.floor(Math.random() * 1000);
    proc = spawn(
      CHROME as string,
      [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${mkdtempSync(join(tmpdir(), "tz-"))}`,
        "--no-first-run",
        "--site-per-process",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        await getVersion(debugPort);
        break;
      } catch {
        if (Date.now() > end) throw new Error("Chrome did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    tz = new TimezoneOverride(debugPort);
    await tz.apply("Asia/Tokyo");

    const client = await Cdp.connect((await getVersion(debugPort)).wsUrl);
    try {
      const { targetId } = await client.send<{ targetId: string }>(
        "Target.createTarget",
        { url: `http://127.0.0.1:${port}/` },
      );
      const { sessionId } = await client.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const read = async () =>
        (
          await client.send<{ result: { value: string } }>(
            "Runtime.evaluate",
            {
              expression:
                "JSON.stringify({first: window.first, offset: window.offset, worker: window.worker, frame: window.frame})",
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value;
      let got: Record<string, unknown> = {};
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        got = JSON.parse(await read()) as Record<string, unknown>;
        if (got.worker && got.frame) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(got).toEqual({
        first: "Asia/Tokyo",
        offset: -540,
        worker: "Asia/Tokyo",
        frame: "Asia/Tokyo",
      });
    } finally {
      client.close();
    }
  }, 40_000);
});
