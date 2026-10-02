import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { PROOF_HEADER } from "@kestrel/contracts";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { applyViewport } from "./cdp.js";
import { chromeArgs } from "./chrome-args.js";
import { ControlServer } from "./control.js";
import { CdpForward } from "./forward.js";
import { Supervisor, type Proc, type SpawnFn } from "./supervisor.js";
import type { Env } from "./config.js";

const PROOF = "ab".repeat(32);
const TOKEN = "control-token-0123456789";

/** Stands in for Chrome: discovery over HTTP and a CDP websocket that models a window with a toolbar. */
class FakeChrome {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  extraW = 16;
  extraH = 85;
  /** Number of setWindowBounds calls that are ignored before one takes effect (a window manager being slow). */
  ignore = 0;
  outer = { w: 1280, h: 800 };
  dpr = 1;
  bounds: unknown[] = [];
  requests: string[] = [];
  noPage = false;
  garbage = false;

  constructor() {
    this.server = createServer((req, res) => {
      this.requests.push(req.url ?? "");
      if (req.url === "/json/version") {
        const port = (this.server.address() as AddressInfo).port;
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify(
            this.garbage
              ? { nope: 1 }
              : {
                  Browser: "Chrome/154.0.8037.92",
                  webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/X`,
                },
          ),
        );
      }
      res.end("chrome says hi");
    });
    this.server.on("upgrade", (req, socket, head) =>
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws)),
    );
  }

  private onSocket(ws: WebSocket): void {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as {
        id: number;
        method: string;
        params?: { bounds?: { width: number; height: number } };
      };
      const reply = (result: unknown) =>
        ws.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case "Target.getTargets":
          return reply({
            targetInfos: this.noPage ? [] : [{ targetId: "T1", type: "page" }],
          });
        case "Target.attachToTarget":
          return reply({ sessionId: "S1" });
        case "Browser.getWindowForTarget":
          return reply({ windowId: 7 });
        case "Browser.setWindowBounds":
          this.bounds.push(m.params?.bounds);
          if (this.ignore > 0) this.ignore--;
          else if (m.params?.bounds)
            this.outer = {
              w: m.params.bounds.width,
              h: m.params.bounds.height,
            };
          return reply({});
        case "Runtime.evaluate":
          return reply({
            result: {
              value: {
                iw: this.outer.w - this.extraW,
                ih: this.outer.h - this.extraH,
                ow: this.outer.w,
                oh: this.outer.h,
                dpr: this.dpr,
              },
            },
          });
        default:
          return ws.send(
            JSON.stringify({ id: m.id, error: { message: "unknown" } }),
          );
      }
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let chrome: FakeChrome | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await chrome?.stop();
  chrome = undefined;
});

const baseCfg: Env = {
  KESTREL_CONTROL_TOKEN: TOKEN,
  KESTREL_PROXY: "http://172.30.1.1:3128",
  KESTREL_NODE: "a",
  CHROME_PATH: "/opt/chrome/chrome",
  XVFB_PATH: "Xvfb",
  DISPLAY_NUM: ":99",
  SCREEN: "1920x1080x24",
  PROFILE_DIR: "/profile",
  CHROME_SANDBOX: "on",
  CONTROL_PORT: 9000,
  FORWARD_PORT: 9223,
  CHROME_PORT: 9222,
  LOG_LEVEL: "info",
};

describe("Chrome's command line (R3, R8, R9, R12)", () => {
  const args = chromeArgs(baseCfg);

  it("goes only through the egress gateway, with the loopback bypass removed", () => {
    expect(args).toContain("--proxy-server=http://172.30.1.1:3128");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
  });

  it("allows no UDP that bypasses the proxy: QUIC off, WebRTC proxied only", () => {
    expect(args).toContain("--disable-quic");
    expect(args).toContain(
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });

  it("debugs on localhost only, with a per-session profile, and nothing updates or reports home", () => {
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--user-data-dir=/profile");
    for (const f of [
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
      "--disk-cache-size=104857600",
    ]) {
      expect(args).toContain(f);
    }
  });

  it("keeps Chrome's sandbox on unless told otherwise, and never turns off the proxy", () => {
    expect(args).not.toContain("--no-sandbox");
    expect(chromeArgs({ ...baseCfg, CHROME_SANDBOX: "off" })).toContain(
      "--no-sandbox",
    );
    expect(
      chromeArgs({ ...baseCfg, CHROME_SANDBOX: "off" }).some((a) =>
        a.startsWith("--proxy-server="),
      ),
    ).toBe(true);
    expect(
      args.some(
        (a) =>
          a.startsWith("--proxy-bypass-list=") &&
          a !== "--proxy-bypass-list=<-loopback>",
      ),
    ).toBe(false);
  });

  it("puts the window at the top-left of the display and opens a blank page", () => {
    expect(args).toContain("--window-position=0,0");
    expect(args.at(-1)).toBe("about:blank");
  });
});

describe("the CDP forward (R7, C10)", () => {
  async function rig() {
    chrome = new FakeChrome();
    const port = await chrome.start();
    const fwd = new CdpForward(port);
    const fport = await fwd.listen(0, "127.0.0.1");
    closers.push(() => fwd.close());
    return { fwd, port: fport };
  }
  const exchange = (port: number, request: string, ms = 600): Promise<string> =>
    new Promise((resolve) => {
      const s = connect({ host: "127.0.0.1", port });
      let out = "";
      s.on("data", (d) => (out += d.toString("latin1")));
      s.on("close", () => resolve(out));
      s.on("error", () => undefined);
      s.write(request);
      setTimeout(() => (s.destroy(), resolve(out)), ms);
    });
  const get = (path: string, proof?: string) =>
    `GET ${path} HTTP/1.1\r\nHost: x\r\n${proof ? `${PROOF_HEADER}: ${proof}\r\n` : ""}\r\n`;

  it("refuses everything with 503 until the container is configured", async () => {
    const { port } = await rig();
    expect(await exchange(port, get("/json/version", PROOF))).toMatch(
      /^HTTP\/1\.1 503/,
    );
  });

  it("passes a connection with the right proof to Chrome, and refuses anything else with 403", async () => {
    const { fwd, port } = await rig();
    expect(fwd.setProof(PROOF)).toBe(true);
    expect(await exchange(port, get("/json/version", PROOF))).toContain(
      "Chrome/154",
    );
    for (const bad of [
      undefined,
      "wrong",
      PROOF.slice(0, 63),
      PROOF + "0",
      "",
      PROOF.toUpperCase(),
    ]) {
      expect(
        await exchange(port, get("/json/version", bad)),
        String(bad),
      ).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(chrome!.requests.filter((r) => r === "/json/version")).toHaveLength(
      1,
    ); // only the good one reached Chrome
  });

  it("accepts the header in any case, with whitespace", async () => {
    const { fwd, port } = await rig();
    fwd.setProof(PROOF);
    const r = await exchange(
      port,
      `GET /json/version HTTP/1.1\r\nHost: x\r\nX-Kestrel-Session-Proof:    ${PROOF}   \r\n\r\n`,
    );
    expect(r).toContain("Chrome/154");
  });

  it("is idempotent for its proof and refuses a different one: a container serves one session", async () => {
    const { fwd } = await rig();
    expect(fwd.setProof(PROOF)).toBe(true);
    expect(fwd.setProof(PROOF)).toBe(true);
    expect(fwd.setProof("cd".repeat(32))).toBe(false);
  });

  it("relays a websocket through untouched, in both directions", async () => {
    const { fwd, port } = await rig();
    fwd.setProof(PROOF);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/X`, {
      headers: { [PROOF_HEADER]: PROOF },
    });
    await new Promise<void>(
      (r, j) => (ws.once("open", () => r()), ws.once("error", j)),
    );
    const reply = new Promise<string>((r) =>
      ws.once("message", (d) => r(d.toString())),
    );
    ws.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    expect(JSON.parse(await reply).result.targetInfos[0].targetId).toBe("T1");
    ws.close();
  });

  it("does not forward a websocket upgrade that lacks the proof", async () => {
    const { fwd, port } = await rig();
    fwd.setProof(PROOF);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/X`);
    const err = await new Promise<string>((r) =>
      ws.once("error", (e) => r(e.message)),
    );
    expect(err).toMatch(/403/);
  });

  it("refuses an oversized request head and drops a client that never finishes one", async () => {
    const { fwd, port } = await rig();
    fwd.setProof(PROOF);
    expect(
      await exchange(port, `GET / HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}`),
    ).toMatch(/^HTTP\/1\.1 431/);
    const t = Date.now();
    const s = connect({ host: "127.0.0.1", port });
    s.on("error", () => undefined);
    s.write("GET / HTTP/1.1\r\nHost: x\r\n"); // never completes
    await new Promise<void>((r) => s.once("close", () => r()));
    expect(Date.now() - t).toBeGreaterThanOrEqual(4000);
  }, 15_000);

  it("closes the client when Chrome is not there", async () => {
    const fwd = new CdpForward(1);
    const p = await fwd.listen(0, "127.0.0.1");
    closers.push(() => fwd.close());
    fwd.setProof(PROOF);
    expect((await exchange(p, get("/", PROOF))).length).toBe(0);
  });
});

describe("sizing the page to the viewport (A6)", () => {
  it("makes innerWidth and innerHeight exactly what was asked, by allowing for the toolbar and borders", async () => {
    chrome = new FakeChrome();
    const port = await chrome.start();
    const r = await applyViewport(port, { width: 1000, height: 600 });
    expect(r).toEqual({
      viewport: { width: 1000, height: 600 },
      deviceScaleFactor: 1,
      chromeVersion: "Chrome/154.0.8037.92",
    });
    expect(chrome.bounds[0]).toMatchObject({
      left: 0,
      top: 0,
      width: 1016,
      height: 685,
    }); // viewport + 16 + 85
  });

  it("corrects when the window comes out wrong, and reports what it ends up with", async () => {
    chrome = new FakeChrome();
    chrome.ignore = 1; // the first resize is lost
    const port = await chrome.start();
    expect(
      (await applyViewport(port, { width: 800, height: 500 })).viewport,
    ).toEqual({ width: 800, height: 500 });
    expect(chrome.bounds.length).toBe(2);
  });

  it("tells the truth if it cannot get there, so the agent can refuse the container", async () => {
    chrome = new FakeChrome();
    chrome.ignore = 99;
    const port = await chrome.start();
    const r = await applyViewport(port, { width: 800, height: 500 });
    expect(r.viewport).not.toEqual({ width: 800, height: 500 });
  });

  it("reports the device scale factor, and fails on a browser that has no page or gives garbage", async () => {
    chrome = new FakeChrome();
    chrome.dpr = 2;
    const port = await chrome.start();
    expect(
      (await applyViewport(port, { width: 800, height: 500 }))
        .deviceScaleFactor,
    ).toBe(2);
    chrome.noPage = true;
    await expect(
      applyViewport(port, { width: 800, height: 500 }),
    ).rejects.toThrow(/no page/);
    chrome.noPage = false;
    chrome.garbage = true;
    await expect(
      applyViewport(port, { width: 800, height: 500 }),
    ).rejects.toThrow(/malformed/);
  });
});

function fakeSpawn() {
  const procs: {
    cmd: string;
    args: string[];
    env: Record<string, string>;
    exit: (c: number | null) => void;
    killed: boolean;
  }[] = [];
  const spawn: SpawnFn = (cmd, args, env) => {
    const entry = {
      cmd,
      args,
      env,
      killed: false,
      exit: (_c: number | null): void => undefined,
    };
    let cb: (c: number | null, s: string | null) => void = () => undefined;
    entry.exit = (c): void => cb(c, null);
    procs.push(entry);
    return {
      on: (_e, f) => (cb = f),
      kill: () => (entry.killed = true),
    } as Proc;
  };
  return { procs, spawn };
}

describe("the supervisor (R4-R6)", () => {
  async function sup(opts: { chromeUp?: boolean } = {}) {
    chrome = new FakeChrome();
    const port = await chrome.start();
    if (opts.chromeUp === false) await chrome.stop();
    const { procs, spawn } = fakeSpawn();
    const fatal: string[] = [];
    const s = new Supervisor(
      { ...baseCfg, CHROME_PORT: port },
      spawn,
      (w) => fatal.push(w),
      "/dev/null",
      {
        displayMs: 500,
        chromeMs: opts.chromeUp === false ? 400 : 2000,
        pollMs: 20,
      },
    );
    return { s, procs, fatal };
  }

  it("starts the display, then Chrome with the display set, and is ready only when Chrome answers", async () => {
    const { s, procs } = await sup();
    expect(s.state).toBe("starting");
    await s.start();
    expect(procs.map((p) => p.cmd)).toEqual(["Xvfb", "/opt/chrome/chrome"]);
    expect(procs[0]!.args).toEqual([
      ":99",
      "-screen",
      "0",
      "1920x1080x24",
      "-nolisten",
      "tcp",
      "-noreset",
    ]);
    expect(procs[1]!.env.DISPLAY).toBe(":99");
    expect(s.state).toBe("ready");
    expect(s.chromeVersion).toBe("Chrome/154.0.8037.92");
  });

  it("stops everything if Chrome dies, and does not restart it (a browser is used once)", async () => {
    const { s, procs, fatal } = await sup();
    await s.start();
    procs[1]!.exit(139);
    expect(s.state).toBe("failed");
    expect(fatal[0]).toMatch(/Chrome exited/);
    expect(procs.every((p) => p.killed)).toBe(true);
    expect(procs).toHaveLength(2);
  });

  it("stops everything if the display dies", async () => {
    const { s, procs, fatal } = await sup();
    await s.start();
    procs[0]!.exit(1);
    expect(fatal[0]).toMatch(/Xvfb exited/);
    expect(s.chromeReady).toBe(false);
  });

  it("fails if Chrome never answers", async () => {
    const { s, fatal } = await sup({ chromeUp: false });
    await s.start();
    expect(s.state).toBe("failed");
    expect(fatal[0]).toMatch(/did not become ready/);
  });

  it("fails if the display never appears", async () => {
    chrome = new FakeChrome();
    const { spawn } = fakeSpawn();
    const fatal: string[] = [];
    const s = new Supervisor(
      baseCfg,
      spawn,
      (w) => fatal.push(w),
      "/nonexistent/X99",
      { displayMs: 150, chromeMs: 100, pollMs: 20 },
    );
    await s.start();
    expect(fatal[0]).toMatch(/display did not start/);
  });
});

describe("the control API (C5)", () => {
  async function rig() {
    chrome = new FakeChrome();
    const port = await chrome.start();
    const fwd = new CdpForward(port);
    const { spawn } = fakeSpawn();
    const sup = new Supervisor(
      { ...baseCfg, CHROME_PORT: port },
      spawn,
      () => undefined,
      "/dev/null",
      { displayMs: 200, chromeMs: 2000, pollMs: 20 },
    );
    const control = new ControlServer(TOKEN, sup, fwd, port);
    const cport = await control.listen(0, "127.0.0.1");
    closers.push(() => control.close());
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      token: string | null = TOKEN,
    ) => {
      const res = await fetch(`http://127.0.0.1:${cport}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
    return { sup, fwd, call };
  }

  it("needs the token", async () => {
    const { call } = await rig();
    expect((await call("GET", "/health", undefined, null)).status).toBe(401);
    expect((await call("GET", "/health", undefined, "wrong")).status).toBe(401);
    expect((await call("POST", "/configure", {}, "wrong")).status).toBe(401);
  });

  it("reports health honestly: starting, then ready", async () => {
    const { sup, call } = await rig();
    expect((await call("GET", "/health")).json).toMatchObject({
      protocolVersion: 1,
      status: "starting",
      chromeReady: false,
    });
    await sup.start();
    expect((await call("GET", "/health")).json).toMatchObject({
      status: "ready",
      chromeReady: true,
      chromeVersion: "Chrome/154.0.8037.92",
    });
  });

  it("will not configure a browser that is not ready", async () => {
    const { call } = await rig();
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
        })
      ).status,
    ).toBe(503);
  });

  it("binds the container to a session and sizes the page, answering what the page reports", async () => {
    const { sup, fwd, call } = await rig();
    await sup.start();
    const res = await call("POST", "/configure", {
      sessionProof: PROOF,
      viewport: { width: 1280, height: 720 },
    });
    expect(res).toMatchObject({
      status: 200,
      json: {
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        chromeVersion: "Chrome/154.0.8037.92",
      },
    });
    expect(fwd.configured).toBe(true);
    // configuring again for the same session is harmless; another session is refused
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: "cd".repeat(32),
          viewport: { width: 1280, height: 720 },
        })
      ).status,
    ).toBe(409);
  });

  it("validates the request", async () => {
    const { sup, call } = await rig();
    await sup.start();
    for (const bad of [
      {},
      { sessionProof: "short", viewport: { width: 1280, height: 720 } },
      { sessionProof: PROOF, viewport: { width: 10, height: 10 } },
    ]) {
      expect((await call("POST", "/configure", bad)).status).toBe(400);
    }
    expect((await call("GET", "/nothing")).status).toBe(404);
  });
});
