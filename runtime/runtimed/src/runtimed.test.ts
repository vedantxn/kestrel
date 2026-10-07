import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PROOF_HEADER,
  RECORDING_FRAGMENTS_HEADER,
  RecordingFragments,
  RuntimeCaptcha,
} from "@kestrel/contracts";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { applyViewport, ViewportSizer } from "./cdp.js";
import { chromeArgs } from "./chrome-args.js";
import { Tabs } from "./page.js";
import { CaptchaWatcher } from "./captcha.js";
import { TimezoneOverride } from "./timezone.js";
import { ControlServer } from "./control.js";
import { CdpForward } from "./forward.js";
import { Recorder } from "./recorder.js";
import { Supervisor, type Proc, type SpawnFn } from "./supervisor.js";
import { stream } from "./test/mp4.js";
import type { Env } from "./config.js";
import type { GuestClock } from "./clock.js";

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
  /** CDP websocket connections opened. */
  connections = 0;
  /** Pages: the snapshot's first, then any made by createTarget. */
  pages = ["T1"];
  closed: string[] = [];

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
    this.connections++;
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
            targetInfos: this.noPage
              ? []
              : this.pages.map((targetId) => ({ targetId, type: "page" })),
          });
        case "Target.attachToTarget":
          return reply({ sessionId: "S1" });
        case "Target.createTarget": {
          const id = `T${this.pages.length + this.closed.length + 1}`;
          this.pages.push(id);
          return reply({ targetId: id });
        }
        case "Target.closeTarget": {
          const id = (m.params as { targetId?: string } | undefined)?.targetId;
          this.pages = this.pages.filter((p) => p !== id);
          if (id) this.closed.push(id);
          return reply({ success: true });
        }
        case "Browser.getWindowForTarget":
          return reply({ windowId: 7 });
        case "Target.setAutoAttach":
          return reply({});
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
  RECORDING_DIR: "/nonexistent",
  CHROME_PATH: "/opt/chrome/chrome",
  XVFB_PATH: "Xvfb",
  DISPLAY_NUM: ":99",
  SCREEN: "1920x1080x24",
  PROFILE_DIR: "/profile",
  CHROME_SANDBOX: "on",
  SNAPSHOT: "off",
  KESTREL_CHROME: "now",
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

  it("starts no spare renderer in a snapshot, so no page process is shared by its clones (V7)", () => {
    const off = chromeArgs(baseCfg).find((a) =>
      a.startsWith("--disable-features="),
    );
    expect(off).not.toMatch(/SpareRenderer/);
    const on = chromeArgs({ ...baseCfg, SNAPSHOT: "on" }).find((a) =>
      a.startsWith("--disable-features="),
    );
    expect(on).toMatch(/,SpareRendererForSitePerProcess$/);
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
  it("sized once while warming, a start that asks for the same viewport only measures it", async () => {
    chrome = new FakeChrome();
    const port = await chrome.start();
    const sizer = new ViewportSizer(port);
    closers.push(async () => sizer.close());
    await sizer.apply({ width: 1280, height: 720 });
    expect(chrome.bounds).toHaveLength(1);
    const r = await sizer.apply({ width: 1280, height: 720 });
    expect(r.viewport).toEqual({ width: 1280, height: 720 });
    expect(chrome.bounds).toHaveLength(1); // no second resize
    expect(chrome.connections).toBe(1); // and no second connection
    // A different viewport is still sized, on the same connection.
    await sizer.apply({ width: 800, height: 500 });
    expect(chrome.bounds).toHaveLength(2);
    expect(chrome.connections).toBe(1);
  });

  it("makes innerWidth and innerHeight exactly what was asked, by allowing for the toolbar and borders", async () => {
    chrome = new FakeChrome();
    const port = await chrome.start();
    const r = await applyViewport(port, { width: 1000, height: 600 });
    expect(r).toMatchObject({
      viewport: { width: 1000, height: 600 },
      deviceScaleFactor: 1,
      chromeVersion: "Chrome/154.0.8037.92",
    });
    // The whole window is larger than the page by the toolbar and borders: what the recorder captures.
    expect(r.window.width).toBeGreaterThan(1000);
    expect(r.window.height).toBeGreaterThan(600);
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

  it("runs its preparation after Chrome answers and before it counts as ready", async () => {
    const { s } = await sup();
    const seen: string[] = [];
    s.prepare = async () => {
      seen.push(s.state);
    };
    await s.start();
    expect(seen).toEqual(["starting"]);
    expect(s.state).toBe("ready");
  });

  it("is ready even if its preparation fails", async () => {
    const { s } = await sup();
    s.prepare = () => Promise.reject(new Error("no page"));
    await s.start();
    expect(s.state).toBe("ready");
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
  async function rig(
    opts: {
      snapshot?: boolean;
      captcha?: boolean;
      recorder?: Recorder;
      timezone?: boolean;
      clock?: GuestClock;
    } = {},
  ) {
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
    const control = new ControlServer(
      TOKEN,
      sup,
      fwd,
      port,
      new Tabs(),
      opts.recorder,
      undefined,
      opts.snapshot ?? false,
      opts.captcha ? new CaptchaWatcher(port) : undefined,
      opts.timezone ? new TimezoneOverride(port) : undefined,
      opts.clock,
    );
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
    const raw = (path: string, token: string | null = TOKEN) =>
      fetch(`http://127.0.0.1:${cport}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    return { sup, fwd, call, raw, port };
  }

  /** A recorder whose ffmpeg is a stream the test writes to. */
  function pullRecorder() {
    const out = new PassThrough();
    const stdin = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout: out,
      stdin,
      kill: () => (
        out.end(),
        setImmediate(() => proc.emit("exit", null, "SIGKILL"))
      ),
    });
    stdin.on("data", () =>
      setImmediate(() => (out.end(), proc.emit("exit", 0, null))),
    );
    const spawned: string[][] = [];
    const recorder = new Recorder(
      "/nonexistent-dir",
      ":99",
      ((_c: string, a: string[]) => (spawned.push(a), proc)) as never,
    );
    return { recorder, out, spawned };
  }

  it("serves a microVM's recording as fragments the agent pulls, never before configure", async () => {
    const { recorder, out, spawned } = pullRecorder();
    const { sup, call, raw } = await rig({ snapshot: true, recorder });
    await sup.start();
    // The template (and a clone before its session is bound) records nothing.
    expect((await raw("/recording/fragments?after=0", null)).status).toBe(401);
    expect((await raw("/recording/fragments?after=0")).status).toBe(409);
    expect(spawned).toEqual([]);
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
          recording: true,
          recordingSink: "pull",
        })
      ).status,
    ).toBe(200);
    expect(spawned[0]).toContain("pipe:1");
    for (const bad of ["", "?after=-1", "?after=x", "?after=1e3"])
      expect((await raw(`/recording/fragments${bad}`)).status).toBe(400);

    const s = stream(2);
    out.write(s);
    await new Promise((r) => setImmediate(r));
    const res = await raw("/recording/fragments?after=0");
    expect(res.status).toBe(200);
    const meta = RecordingFragments.parse(
      JSON.parse(res.headers.get(RECORDING_FRAGMENTS_HEADER)!),
    );
    expect(meta).toMatchObject({ state: "recording", done: false });
    expect(meta.fragments.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(s);
    // Acknowledged by asking for what comes after; going back is refused.
    const next = await raw("/recording/fragments?after=4");
    expect(
      JSON.parse(next.headers.get(RECORDING_FRAGMENTS_HEADER)!),
    ).toMatchObject({ fragments: [] });
    expect((await raw("/recording/fragments?after=2")).status).toBe(409);
    expect((await raw("/recording/fragments?after=9")).status).toBe(409);

    expect((await call("POST", "/recording/stop")).json).toEqual({
      state: "stopped",
    });
    const last = await raw("/recording/fragments?after=4");
    expect(
      JSON.parse(last.headers.get(RECORDING_FRAGMENTS_HEADER)!),
    ).toMatchObject({ state: "stopped", fragments: [], done: true });
  });

  it("has no fragments to pull for a container recording to its volume", async () => {
    const { recorder } = pullRecorder();
    const { sup, call, raw } = await rig({ recorder });
    await sup.start();
    await call("POST", "/configure", {
      sessionProof: PROOF,
      viewport: { width: 1280, height: 720 },
      recording: true,
    });
    expect((await raw("/recording/fragments?after=0")).status).toBe(404);
  });

  it("lets a snapshot clone replace its token once, then refuses the template's, and gives it a fresh page", async () => {
    const { sup, call } = await rig({ snapshot: true });
    await sup.start();
    const fresh = "c".repeat(48);
    expect(
      (await call("POST", "/rekey", { token: fresh }, "wrong")).status,
    ).toBe(401);
    expect((await call("POST", "/rekey", { token: "short" })).status).toBe(400);
    expect((await call("POST", "/rekey", { token: fresh })).json).toEqual({
      ok: true,
      now: expect.any(Number), // the guest's clock (P18)
    });
    // The snapshot's page is gone; the session's page was made after the restore.
    expect(chrome!.closed).toEqual(["T1"]);
    expect(chrome!.pages).toEqual(["T2"]);
    expect((await call("GET", "/health")).status).toBe(401);
    expect((await call("GET", "/health", undefined, fresh)).status).toBe(200);
    expect(
      (await call("POST", "/rekey", { token: "d".repeat(48) }, fresh)).status,
    ).toBe(409);
  });

  it("sets a clone's clock to the host's at rekey, before the session's page is made (9.1)", async () => {
    const set: { epochMs: number; pagesThen: string[] }[] = [];
    const clock: GuestClock = {
      set: async (epochMs) => {
        set.push({ epochMs, pagesThen: [...chrome!.pages] });
        return true;
      },
    };
    const { sup, call } = await rig({ snapshot: true, clock });
    await sup.start();
    const now = 1_791_369_000_000;
    expect(
      (await call("POST", "/rekey", { token: "c".repeat(48), now })).json,
    ).toEqual({ ok: true });
    // Set while only the snapshot's page existed: the new page starts with the right time.
    expect(set).toEqual([{ epochMs: now, pagesThen: ["T1"] }]);
    expect(chrome!.pages).toEqual(["T2"]);
  });

  it("answers GET /captcha only with the token and once configured; 404 without detection", async () => {
    const { sup, call } = await rig({ captcha: true });
    await sup.start();
    expect((await call("GET", "/captcha", undefined, null)).status).toBe(401);
    expect((await call("GET", "/captcha")).status).toBe(409);
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
        })
      ).status,
    ).toBe(200);
    const res = await call("GET", "/captcha");
    expect(res.status).toBe(200);
    expect(RuntimeCaptcha.parse(res.json).detections).toEqual([]);
    const old = await rig();
    await old.sup.start();
    expect((await old.call("GET", "/captcha")).status).toBe(404);
  });

  it("makes a probe of a clone rekeyed as one: never a session, and /probe only there (G-23)", async () => {
    const { sup, call, port } = await rig({ snapshot: true });
    await sup.start();
    const probeToken = "e".repeat(48);
    // Before the rekey, and on any browser that is not a probe, there is no /probe.
    expect(
      (
        await call("POST", "/probe", {
          targets: [{ name: "x", host: "127.0.0.1", port: 1 }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("POST", "/rekey", { token: probeToken, probe: true })).json,
    ).toEqual({ ok: true, now: expect.any(Number) });
    // The snapshot's page is kept: a probe shows nothing.
    expect(chrome!.closed).toEqual([]);
    expect(
      (
        await call(
          "POST",
          "/configure",
          { sessionProof: PROOF, viewport: { width: 1280, height: 720 } },
          probeToken,
        )
      ).status,
    ).toBe(409);
    expect(
      (await call("POST", "/probe", { targets: [] }, probeToken)).status,
    ).toBe(400);
    const r = await call(
      "POST",
      "/probe",
      {
        targets: [
          { name: "chrome", host: "127.0.0.1", port },
          { name: "closed", host: "127.0.0.1", port: 1, timeoutMs: 500 },
        ],
      },
      probeToken,
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      results: [
        { name: "chrome", result: "connected" },
        { name: "closed", result: "ECONNREFUSED" },
      ],
    });
    expect(
      (await call("POST", "/rekey", { token: "d".repeat(48) }, probeToken))
        .status,
    ).toBe(409);
  });

  it("answers the solving paths only for a session configured to solve", async () => {
    const configure = (captchaSolve?: boolean) => ({
      sessionProof: PROOF,
      viewport: { width: 1280, height: 720 },
      ...(captchaSolve === undefined ? {} : { captchaSolve }),
    });
    const inject = { id: "0123456789abcdef", token: "03AF-x" };
    const plain = await rig({ captcha: true });
    await plain.sup.start();
    expect((await plain.call("GET", "/captcha/challenges")).status).toBe(409);
    expect((await plain.call("POST", "/configure", configure())).status).toBe(
      200,
    );
    // Without captchaSolve, no site key or page URL leaves runtimed (T-51).
    expect((await plain.call("GET", "/captcha/challenges")).status).toBe(409);
    expect((await plain.call("POST", "/captcha/inject", inject)).status).toBe(
      409,
    );

    const solving = await rig({ captcha: true });
    await solving.sup.start();
    expect(
      (await solving.call("POST", "/configure", configure(true))).status,
    ).toBe(200);
    const res = await solving.call("GET", "/captcha/challenges");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ challenges: [] });
    expect(
      (await solving.call("GET", "/captcha/challenges", undefined, null))
        .status,
    ).toBe(401);
    expect(
      (
        await solving.call("POST", "/captcha/inject", {
          ...inject,
          token: 'x"; alert(1)',
        })
      ).status,
    ).toBe(400);
    expect(
      (await solving.call("POST", "/captcha/inject", inject)).json,
    ).toEqual({ result: "gone", callback: false });

    const old = await rig();
    await old.sup.start();
    expect((await old.call("GET", "/captcha/challenges")).status).toBe(404);
  });

  it("has nothing to rekey when it is not a snapshot clone", async () => {
    const { sup, call } = await rig();
    await sup.start();
    expect(
      (await call("POST", "/rekey", { token: "c".repeat(48) })).status,
    ).toBe(409);
  });

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

  it("holds a health call with wait until the browser is ready", async () => {
    const { sup, call } = await rig();
    const pending = call("GET", "/health?wait=5000");
    await new Promise((r) => setTimeout(r, 100));
    void sup.start();
    const t0 = Date.now();
    expect((await pending).json).toMatchObject({
      status: "ready",
      chromeReady: true,
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    // and gives up after the wait if it never is
    const { call: call2 } = await rig();
    const t1 = Date.now();
    expect((await call2("GET", "/health?wait=150")).json).toMatchObject({
      status: "starting",
    });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(140);
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

  it("holds the session's time zone before it answers, and says which is in force", async () => {
    const { sup, call } = await rig({ timezone: true });
    await sup.start();
    const res = await call("POST", "/configure", {
      sessionProof: PROOF,
      viewport: { width: 1280, height: 720 },
      timezone: "Asia/Tokyo",
    });
    expect(res).toMatchObject({
      status: 200,
      json: { timezone: "Asia/Tokyo" },
    });
    expect(
      (
        await call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
          timezone: "Not/AZone",
        })
      ).status,
    ).toBe(400);
  });

  it("answers timezone null when none was asked for, and 501 when it cannot hold one", async () => {
    const plain = await rig({ timezone: true });
    await plain.sup.start();
    expect(
      await plain.call("POST", "/configure", {
        sessionProof: PROOF,
        viewport: { width: 1280, height: 720 },
      }),
    ).toMatchObject({ status: 200, json: { timezone: null } });
    const without = await rig();
    await without.sup.start();
    expect(
      (
        await without.call("POST", "/configure", {
          sessionProof: PROOF,
          viewport: { width: 1280, height: 720 },
          timezone: "Asia/Tokyo",
        })
      ).status,
    ).toBe(501);
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
