import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_LIMITS,
  encodeProfileArchive,
  encodeProfileArchiveHead,
  parseProfileArchive,
  type ProfileCookie,
} from "@kestrel/contracts";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Cdp, getVersion } from "./cdp.js";
import { chromeArgs } from "./chrome-args.js";
import type { Env } from "./config.js";
import { ControlServer } from "./control.js";
import { CdpForward } from "./forward.js";
import { Tabs } from "./page.js";
import {
  ProfileError,
  ProfileModule,
  collectProfileFiles,
  readCookies,
  restoreProfileArchive,
  toCookieParam,
  writeCookies,
} from "./profile.js";
import { Supervisor, type Proc, type SpawnFn } from "./supervisor.js";

const TOKEN = "control-token-0123456789";
const PROOF = "ab".repeat(32);
const MAX = PROFILE_LIMITS.maxBytes;

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tmp = (p = "prof-") => mkdtempSync(join(tmpdir(), p));

/** Chrome's browser target, as far as profiles use it. */
class FakeBrowser {
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  cookies: Record<string, unknown>[] = [];
  set: unknown[] = [];
  calls: string[] = [];
  constructor() {
    this.server = createServer((req, res) => {
      const port = (this.server.address() as AddressInfo).port;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          Browser: "Chrome/154.0.8037.92",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/X`,
        }),
      );
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
        params?: { cookies?: unknown[] };
      };
      this.calls.push(m.method);
      const reply = (result: unknown) =>
        ws.send(JSON.stringify({ id: m.id, result }));
      if (m.method === "Storage.getCookies")
        return reply({ cookies: this.cookies });
      if (m.method === "Storage.setCookies") {
        this.set.push(...(m.params?.cookies ?? []));
        return reply({});
      }
      if (m.method === "Browser.close") return reply({});
      if (m.method === "Target.getTargets") return reply({ targetInfos: [] });
      if (m.method === "Target.createTarget") return reply({ targetId: "T9" });
      ws.send(JSON.stringify({ id: m.id, error: { message: "unknown" } }));
    });
  }
  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    closers.push(async () => {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server.close(() => r()));
    });
    return (this.server.address() as AddressInfo).port;
  }
}

/** The supervisor as the profile module sees it. */
class FakeSupervisor {
  state: Supervisor["state"] = "ready";
  chromeVersion: string | null = "Chrome/154.0.8037.92";
  exits = true;
  launched: { width: number; height: number }[] = [];
  closes = 0;
  get chromeReady() {
    return this.state === "ready";
  }
  get health() {
    return this.state === "closed" ? "failed" : this.state;
  }
  async launch(size: { width: number; height: number }) {
    this.launched.push(size);
    this.state = "ready";
  }
  async closeChrome(ask: () => Promise<unknown>) {
    this.closes++;
    this.state = "closed";
    await ask();
    return this.exits ? ("exited" as const) : ("killed" as const);
  }
  async settle() {}
}

const cookie = (over: Partial<ProfileCookie> = {}): ProfileCookie => ({
  name: "sid",
  value: "v1",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  expires: 1_900_000_000,
  ...over,
});

async function* chunks(b: Buffer, size = 7): AsyncIterable<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

function plant(dir: string, files: Record<string, string>): void {
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), data);
  }
}

const cfg: Env = {
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
  KESTREL_CHROME: "deferred",
  CONTROL_PORT: 9000,
  FORWARD_PORT: 9223,
  CHROME_PORT: 9222,
  LOG_LEVEL: "info",
};

function fakeSpawn() {
  const procs: { cmd: string; args: string[]; exit: (c: number) => void }[] =
    [];
  const spawnFn: SpawnFn = (cmd, args) => {
    let cb: (c: number | null, s: string | null) => void = () => undefined;
    procs.push({ cmd, args, exit: (c) => cb(c, null) });
    return { on: (_e, f) => (cb = f), kill: () => undefined } as Proc;
  };
  return { procs, spawnFn };
}

describe("deferred launch (KESTREL_CHROME=deferred)", () => {
  it("starts the display only and is warm; launch starts Chrome with the usual flags at the session's size", async () => {
    const chrome = new FakeBrowser();
    const port = await chrome.start();
    const { procs, spawnFn } = fakeSpawn();
    const fatal: string[] = [];
    const s = new Supervisor(
      { ...cfg, CHROME_PORT: port },
      spawnFn,
      (w) => fatal.push(w),
      "/dev/null",
      { displayMs: 200, chromeMs: 2000, pollMs: 10 },
    );
    await s.start();
    expect(s.state).toBe("warm");
    expect(s.health).toBe("warm");
    expect(procs.map((p) => p.cmd)).toEqual(["Xvfb"]);
    await s.settle(5_000); // a warm browser has settled: no wait

    await s.launch({ width: 1024, height: 700 });
    expect(s.state).toBe("ready");
    expect(procs[1]!.cmd).toBe("/opt/chrome/chrome");
    const now = chromeArgs({ ...cfg, CHROME_PORT: port });
    const sized = chromeArgs(
      { ...cfg, CHROME_PORT: port },
      {
        width: 1024,
        height: 700,
      },
    );
    expect(procs[1]!.args).toEqual(sized);
    // the same flags as a hot browser's but for the size
    expect(sized.filter((a) => !now.includes(a))).toEqual([
      "--window-size=1024,700",
    ]);
    await expect(s.launch({ width: 1, height: 1 })).rejects.toThrow();
    expect(fatal).toEqual([]);
  });

  it("expects Chrome's exit while closing it for a save, and kills one that will not go", async () => {
    const chrome = new FakeBrowser();
    const port = await chrome.start();
    const { procs, spawnFn } = fakeSpawn();
    const fatal: string[] = [];
    const s = new Supervisor(
      { ...cfg, KESTREL_CHROME: "now", CHROME_PORT: port },
      spawnFn,
      (w) => fatal.push(w),
      "/dev/null",
      { displayMs: 200, chromeMs: 2000, pollMs: 10 },
    );
    await s.start();
    expect(s.state).toBe("ready");
    const how = await s.closeChrome(async () => procs[1]!.exit(0), 1000);
    expect(how).toBe("exited");
    expect(s.state).toBe("closed");
    expect(s.health).toBe("failed");
    expect(fatal).toEqual([]); // not fatal: expected

    const again = new Supervisor(
      { ...cfg, KESTREL_CHROME: "now", CHROME_PORT: port },
      spawnFn,
      (w) => fatal.push(w),
      "/dev/null",
      { displayMs: 200, chromeMs: 2000, pollMs: 10 },
    );
    await again.start();
    expect(await again.closeChrome(async () => undefined, 50)).toBe("killed");
    // the display dying is still fatal
    procs[0]!.exit(1);
    expect(fatal[0]).toMatch(/Xvfb exited/);
  });
});

describe("restore", () => {
  const files = [
    { path: "Default/LocalStorage", data: Buffer.from("ls") },
    {
      path: "Default/IndexedDB/https_a.example_0.indexeddb.leveldb/000003.log",
      data: Buffer.from("idb"),
    },
    { path: "Default/WebStorage/QuotaManager", data: Buffer.alloc(0) },
  ];

  it("writes every file, 0600, into the empty directory, at any chunking", async () => {
    const dir = tmp();
    const archive = encodeProfileArchive([cookie()], files);
    const r = await restoreProfileArchive(dir, chunks(archive, 3), MAX);
    expect(r).toMatchObject({ files: 3, bytes: 5, cookies: [cookie()] });
    for (const f of files) {
      expect(readFileSync(join(dir, f.path))).toEqual(f.data);
      expect(statSync(join(dir, f.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a directory that is not empty", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "Local State"), "{}");
    const archive = encodeProfileArchive([], files);
    await expect(
      restoreProfileArchive(dir, chunks(archive), MAX),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses every bad path, a short or long body, and a manifest that lies", async () => {
    const bad = (paths: string[]) => {
      const json = Buffer.from(
        JSON.stringify({
          format: 1,
          cookies: { bytes: 0, count: 0 },
          files: paths.map((path) => ({ path, bytes: 1 })),
        }),
      );
      const len = Buffer.alloc(4);
      len.writeUInt32BE(json.length);
      return Buffer.concat([len, json, Buffer.alloc(paths.length, 120)]);
    };
    const cases = [
      bad(["Default/IndexedDB/../../etc/passwd"]),
      bad(["/etc/passwd"]),
      bad(["Default/Preferences"]),
      bad(["Local State"]),
      bad(["Default/Extensions/x/manifest.json"]),
      bad(["Default/IndexedDB/a", "Default/IndexedDB/a/b"]),
      bad(["Default/LocalStorage", "Default/LocalStorage"]),
      encodeProfileArchive([], files).subarray(0, 40),
      Buffer.concat([encodeProfileArchive([], files), Buffer.from("x")]),
    ];
    for (const [i, archive] of cases.entries()) {
      const dir = tmp();
      const err = await restoreProfileArchive(dir, chunks(archive), MAX).catch(
        (e: unknown) => e,
      );
      expect(err, `case ${i}`).toBeInstanceOf(ProfileError);
      expect((err as ProfileError).status, `case ${i}`).toBe(400);
      // nothing outside the directory, and no denied file inside it
      expect(
        readdirSync(dir, { recursive: true }).some((p) =>
          String(p).includes("Preferences"),
        ),
      ).toBe(false);
    }
  });

  it("never writes through a link", async () => {
    // The directory is empty when the restore begins. A link planted in it before a file is
    // written (by something else in the container) is not followed: O_EXCL | O_NOFOLLOW.
    const dir = tmp();
    const outside = tmp("out-");
    const body = encodeProfileArchive(
      [],
      [{ path: "Default/LocalStorage", data: Buffer.from("x") }],
    );
    async function* planted(): AsyncIterable<Uint8Array> {
      const manifestEnd = 4 + body.readUInt32BE(0);
      yield body.subarray(0, manifestEnd - 1);
      mkdirSync(join(dir, "Default"), { recursive: true });
      symlinkSync(join(outside, "target"), join(dir, "Default/LocalStorage"));
      yield body.subarray(manifestEnd - 1);
    }
    await expect(restoreProfileArchive(dir, planted(), MAX)).rejects.toThrow(
      ProfileError,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("is refused past the cap from the manifest, before any file is written", async () => {
    const dir = tmp();
    const head = encodeProfileArchiveHead({
      format: 1,
      cookies: { bytes: 0, count: 0 },
      files: [{ path: "Default/LocalStorage", bytes: 1000 }],
    });
    await expect(
      restoreProfileArchive(dir, chunks(head), 999),
    ).rejects.toMatchObject({ status: 400, code: "too_large" });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("collecting the files to save", () => {
  it("takes only allowlisted regular files, never a link, a denied name or anything else", async () => {
    const dir = tmp();
    const outside = tmp("out-");
    writeFileSync(join(outside, "secret"), "secret");
    plant(dir, {
      "Default/LocalStorage": "ls",
      "Default/LocalStorage-journal": "",
      "Default/IndexedDB/http_a_0/ABC": "idb",
      "Default/IndexedDB/https_b_0.indexeddb.leveldb/000003.log": "log",
      "Default/IndexedDB/https_b_0.indexeddb.leveldb/LOCK": "",
      "Default/IndexedDB/https_b_0.indexeddb.leveldb/LOG": "x",
      "Default/WebStorage/QuotaManager": "q",
      "Default/Local Storage/leveldb/000005.ldb": "old",
      "Default/Preferences": "{}",
      "Default/Cookies": "sqlite",
      "Default/Cache/Cache_Data/index": "c",
      "Default/Service Worker/CacheStorage/x": "sw",
      "Default/Extensions/abc/1/manifest.json": "{}",
      "Local State": "{}",
    });
    symlinkSync(
      join(outside, "secret"),
      join(dir, "Default/IndexedDB/http_a_0/LINK"),
    );
    symlinkSync(outside, join(dir, "Default/IndexedDB/linkdir"));
    symlinkSync(join(outside, "secret"), join(dir, "Default/LocalStorage-wal"));
    const got = await collectProfileFiles(dir, MAX);
    expect(got.map((f) => f.path).sort()).toEqual(
      [
        "Default/IndexedDB/http_a_0/ABC",
        "Default/IndexedDB/https_b_0.indexeddb.leveldb/000003.log",
        "Default/Local Storage/leveldb/000005.ldb",
        "Default/LocalStorage",
        "Default/LocalStorage-journal",
        "Default/WebStorage/QuotaManager",
      ].sort(),
    );
    expect(got.some((f) => f.data.toString() === "secret")).toBe(false);
  });

  it("is too_large past the byte cap", async () => {
    const dir = tmp();
    plant(dir, {
      "Default/LocalStorage": "x".repeat(60),
      "Default/IndexedDB/o/1": "y".repeat(60),
    });
    await expect(collectProfileFiles(dir, 100)).rejects.toMatchObject({
      status: 413,
      code: "too_large",
    });
    expect(await collectProfileFiles(dir, 120)).toHaveLength(2);
  });

  it("refuses a huge file from its size, without reading it into memory", async () => {
    const dir = tmp();
    plant(dir, {
      "Default/LocalStorage": "ls",
      "Default/IndexedDB/o/huge": "",
    });
    // 3 GiB, sparse: reading it whole would need 3 GiB of memory (and Node refuses past 2 GiB).
    truncateSync(join(dir, "Default/IndexedDB/o/huge"), 3 * 1024 ** 3);
    await expect(collectProfileFiles(dir, MAX)).rejects.toMatchObject({
      status: 413,
      code: "too_large",
    });
  });

  it("skips a file it cannot read rather than fail", async () => {
    const dir = tmp();
    plant(dir, { "Default/LocalStorage": "ls", "Default/IndexedDB/o/1": "z" });
    chmodSync(join(dir, "Default/IndexedDB/o"), 0o000);
    closers.push(() => chmodSync(join(dir, "Default/IndexedDB/o"), 0o700));
    const got = await collectProfileFiles(dir, MAX);
    expect(got.map((f) => f.path)).toContain("Default/LocalStorage");
  });
});

describe("cookies", () => {
  it("turns CDP cookies into setCookies params, dropping what cannot be set again", () => {
    expect(
      toCookieParam({
        name: "a",
        value: "1",
        domain: ".example.com",
        path: "/",
        expires: -1,
        size: 2,
        httpOnly: false,
        secure: false,
        session: true,
        priority: "Medium",
        sourceScheme: "NonSecure",
        sourcePort: 80,
      }),
    ).toEqual({
      name: "a",
      value: "1",
      domain: ".example.com",
      path: "/",
      secure: false,
      httpOnly: false,
      priority: "Medium",
      sourceScheme: "NonSecure",
      sourcePort: 80,
    });
    expect(
      toCookieParam({
        ...cookie(),
        session: false,
        partitionKey: {
          topLevelSite: "https://a.example",
          hasCrossSiteAncestor: true,
        },
      })?.partitionKey,
    ).toEqual({
      topLevelSite: "https://a.example",
      hasCrossSiteAncestor: true,
    });
    expect(toCookieParam({ ...cookie(), partitionKeyOpaque: true })).toBeNull();
    expect(toCookieParam({ ...cookie(), name: "x".repeat(5000) })).toBeNull();
    expect(toCookieParam({ ...cookie(), domain: 7 })).toBeNull();
  });

  it("reads them from the browser target and sets them back in batches", async () => {
    const b = new FakeBrowser();
    const port = await b.start();
    b.cookies = [
      { ...cookie(), session: false },
      { ...cookie({ name: "opaque" }), partitionKeyOpaque: true },
    ];
    expect(await readCookies(port)).toEqual([cookie()]);
    const many = Array.from({ length: 1200 }, (_, i) =>
      cookie({ name: `c${i}` }),
    );
    expect(await writeCookies(port, many)).toBe(1200);
    expect(b.set).toHaveLength(1200);
    expect(b.calls.filter((c) => c === "Storage.setCookies")).toHaveLength(3);
    // nothing but browser-level calls
    expect(
      b.calls.every((c) => c.startsWith("Storage.") || c === "Browser.close"),
    ).toBe(true);
  });
});

describe("the profile module", () => {
  async function rig() {
    const b = new FakeBrowser();
    const port = await b.start();
    const dir = tmp();
    const sup = new FakeSupervisor();
    const mod = new ProfileModule(dir, port, sup as unknown as Supervisor, 50);
    return { b, port, dir, sup, mod };
  }

  it("saves cookies and files after a clean exit, and answers the same bytes again", async () => {
    const { b, dir, sup, mod } = await rig();
    b.cookies = [{ ...cookie(), session: false }];
    plant(dir, { "Default/LocalStorage": "ls", "Default/Preferences": "{}" });
    const one = await mod.save();
    expect(sup.closes).toBe(1);
    expect(b.calls).toEqual(["Storage.getCookies", "Browser.close"]);
    const parsed = parseProfileArchive(one, MAX);
    expect(parsed.cookies).toEqual([cookie()]);
    expect(parsed.files.map((f) => f.path)).toEqual(["Default/LocalStorage"]);
    const two = await mod.save();
    expect(two.equals(one)).toBe(true);
    expect(sup.closes).toBe(1);
  });

  it("gives 409 and no archive when Chrome will not exit, and the same again", async () => {
    const { sup, mod } = await rig();
    sup.exits = false;
    await expect(mod.save()).rejects.toMatchObject({
      status: 409,
      code: "unclean",
    });
    await expect(mod.save()).rejects.toMatchObject({ code: "unclean" });
  });

  it("refuses to save a browser whose Chrome is not running, or restore one that has", async () => {
    const { sup, mod } = await rig();
    sup.state = "warm";
    await expect(mod.save()).rejects.toMatchObject({ status: 409 });
    sup.state = "ready";
    await expect(
      mod.restore(chunks(encodeProfileArchive([], []))),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("restores once into a warm browser, then sets the cookies at launch", async () => {
    const { b, dir, sup, mod } = await rig();
    sup.state = "warm";
    const archive = encodeProfileArchive(
      [cookie(), cookie({ name: "two" })],
      [{ path: "Default/LocalStorage", data: Buffer.from("ls") }],
    );
    expect(await mod.restore(chunks(archive))).toEqual({
      files: 1,
      bytes: 2,
      cookies: 2,
    });
    expect(readFileSync(join(dir, "Default/LocalStorage"), "utf8")).toBe("ls");
    await expect(mod.restore(chunks(archive))).rejects.toMatchObject({
      status: 409,
    });
    expect(b.set).toEqual([]); // nothing before Chrome is up
    expect(await mod.launch({ width: 1280, height: 720 })).toEqual({
      chromeVersion: "Chrome/154.0.8037.92",
      cookies: 2,
    });
    expect(sup.launched).toEqual([{ width: 1280, height: 720 }]);
    expect(b.set).toHaveLength(2);
    await expect(mod.launch({ width: 1, height: 1 })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("the control API's profile routes", () => {
  async function rig(state: Supervisor["state"], snapshot = false) {
    const b = new FakeBrowser();
    const port = await b.start();
    const dir = tmp();
    const sup = new FakeSupervisor();
    sup.state = state;
    const mod = new ProfileModule(dir, port, sup as unknown as Supervisor, 50);
    const control = new ControlServer(
      TOKEN,
      sup as unknown as Supervisor,
      new CdpForward(port),
      port,
      new Tabs(),
      undefined,
      undefined,
      snapshot,
      undefined,
      undefined,
      undefined,
      mod,
    );
    const cport = await control.listen(0, "127.0.0.1");
    closers.push(() => control.close());
    const call = (
      method: string,
      path: string,
      body?: string | Uint8Array,
      token = TOKEN,
    ) =>
      fetch(`http://127.0.0.1:${cport}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body } : {}),
      });
    return { b, dir, sup, call };
  }

  it("answers health warm; refuses configure until launch; restores, launches and saves", async () => {
    const { b, dir, call } = await rig("warm");
    const health = await (await call("GET", "/health")).json();
    expect(health).toMatchObject({ status: "warm", chromeReady: false });
    const configure = await call(
      "POST",
      "/configure",
      JSON.stringify({
        sessionProof: PROOF,
        viewport: { width: 1280, height: 720 },
      }),
    );
    expect(configure.status).toBe(503);
    expect(
      (
        await call(
          "PUT",
          "/profile",
          new Uint8Array(
            encodeProfileArchive(
              [cookie()],
              [{ path: "Default/LocalStorage", data: Buffer.from("ls") }],
            ),
          ),
          "wrong-token-000000000",
        )
      ).status,
    ).toBe(401);

    const put = await call(
      "PUT",
      "/profile",
      new Uint8Array(
        encodeProfileArchive(
          [cookie()],
          [{ path: "Default/LocalStorage", data: Buffer.from("ls") }],
        ),
      ),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ files: 1, bytes: 2, cookies: 1 });
    const launch = await call(
      "POST",
      "/launch",
      JSON.stringify({ viewport: { width: 1280, height: 720 } }),
    );
    expect(launch.status).toBe(200);
    expect(await launch.json()).toEqual({
      chromeVersion: "Chrome/154.0.8037.92",
      cookies: 1,
    });
    expect(b.set).toHaveLength(1);
    expect(
      (
        await call(
          "POST",
          "/launch",
          JSON.stringify({ viewport: { width: 1280, height: 720 }, extra: 1 }),
        )
      ).status,
    ).toBe(400);

    b.cookies = [{ ...cookie(), session: false }];
    writeFileSync(join(dir, "Default/Preferences"), "{}");
    const save = await call("POST", "/profile/save");
    expect(save.status).toBe(200);
    expect(save.headers.get("content-type")).toBe("application/octet-stream");
    const archive = parseProfileArchive(
      Buffer.from(await save.arrayBuffer()),
      MAX,
    );
    expect(archive.files.map((f) => f.path)).toEqual(["Default/LocalStorage"]);
    expect(archive.cookies).toEqual([cookie()]);
  });

  it("answers 400 for a hostile archive and 409 for a second one", async () => {
    const { call } = await rig("warm");
    const bad = await call(
      "PUT",
      "/profile",
      new Uint8Array(Buffer.from([0, 0, 0, 5, 1, 2])),
    );
    expect(bad.status).toBe(400);
    const again = await call(
      "PUT",
      "/profile",
      new Uint8Array(encodeProfileArchive([], [])),
    );
    expect(again.status).toBe(409);
  });

  it("re-keys a warm clone without making a page, and says its clock", async () => {
    const { b, call } = await rig("warm", true);
    const before = Date.now();
    const res = await call(
      "POST",
      "/rekey",
      JSON.stringify({ token: "cd".repeat(16) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; now: number };
    expect(body.ok).toBe(true);
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(b.calls).toEqual([]); // no Target.createTarget: there is no Chrome yet
  });
});

/*
 * Against a real Chrome, when one is named: KESTREL_TEST_CHROME=/path/to/chrome. A first Chrome
 * stores a session cookie, a persistent HttpOnly cookie, a partitioned cookie, localStorage and an
 * IndexedDB record; the module saves it; a second Chrome launched on the restored files, with the
 * cookies set back, sees all of them.
 */
const CHROME = process.env.KESTREL_TEST_CHROME;
describe.skipIf(!CHROME)("against a real Chrome", () => {
  let procs: ChildProcess[] = [];
  let site: Server | undefined;
  afterEach(async () => {
    for (const p of procs) p.kill("SIGKILL");
    procs = [];
    site?.closeAllConnections();
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
    site = undefined;
  });

  async function launch(dir: string) {
    const port = 21_000 + Math.floor(Math.random() * 1000);
    const proc = spawn(
      CHROME as string,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--use-mock-keychain",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    procs.push(proc);
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        await getVersion(port);
        break;
      } catch {
        if (Date.now() > end) throw new Error("Chrome did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    return { port, proc, exited };
  }

  async function evaluate(
    port: number,
    url: string,
    expr: string,
    until: string,
  ) {
    const cdp = await Cdp.connect((await getVersion(port)).wsUrl);
    try {
      const { targetId } = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url },
      );
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const ev = async (e: string) =>
        (
          await cdp.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression: e, returnByValue: true },
            sessionId,
          )
        ).result.value;
      const stop = Date.now() + 10_000;
      while (!(await ev(until))) {
        if (Date.now() > stop) throw new Error(`timed out on ${until}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return await ev(expr);
    } finally {
      cdp.close();
    }
  }

  it("round-trips cookies, localStorage and IndexedDB through save and restore", async () => {
    let port = 0;
    site = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/write") {
        res.setHeader("set-cookie", [
          "sess=s1; Path=/",
          "hard=h1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
        ]);
        return res.end(`<script>
          localStorage.setItem("ls", "v1");
          const r = indexedDB.open("db", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("s");
          r.onsuccess = () => {
            const tx = r.result.transaction("s", "readwrite");
            tx.objectStore("s").put("idb1", "k");
            tx.oncomplete = () => (window.done = true);
          };
        </script><iframe src="http://localhost:${port}/frame"></iframe>`);
      }
      if (req.url === "/frame") {
        res.setHeader(
          "set-cookie",
          "part=p1; Path=/; Secure; SameSite=None; Partitioned; Max-Age=86400",
        );
        return res.end("frame");
      }
      res.end(`<script>
        window.server = ${JSON.stringify(req.headers.cookie ?? "")};
        window.ls = localStorage.getItem("ls");
        const r = indexedDB.open("db", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("s");
        r.onsuccess = () => {
          const g = r.result.transaction("s").objectStore("s").get("k");
          g.onsuccess = () => (window.idb = g.result ?? null);
        };
      </script>`);
    });
    await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
    port = (site.address() as AddressInfo).port;

    // The first browser stores everything; the module saves it.
    const dirA = tmp("real-a-");
    const a = await launch(dirA);
    await evaluate(
      a.port,
      `http://127.0.0.1:${port}/write`,
      "1",
      "window.done === true",
    );
    await new Promise((r) => setTimeout(r, 500)); // the frame's cookie
    const sup = {
      state: "ready" as Supervisor["state"],
      get chromeReady() {
        return this.state === "ready";
      },
      async closeChrome(ask: () => Promise<unknown>, ms: number) {
        this.state = "closed";
        await ask();
        const inTime = await Promise.race([
          a.exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
        ]);
        return inTime ? ("exited" as const) : ("killed" as const);
      },
    };
    const mod = new ProfileModule(dirA, a.port, sup as unknown as Supervisor);
    const archive = await mod.save();
    const parsed = parseProfileArchive(archive, MAX);
    expect(parsed.cookies.map((c) => c.name).sort()).toEqual([
      "hard",
      "part",
      "sess",
    ]);
    expect(
      parsed.cookies.find((c) => c.name === "sess")?.expires,
    ).toBeUndefined();
    expect(
      parsed.cookies.find((c) => c.name === "part")?.partitionKey,
    ).toBeDefined();
    expect(
      parsed.files.some((f) => f.path.startsWith("Default/IndexedDB/")),
    ).toBe(true);

    // The second browser starts on the restored files, with the cookies set back.
    const dirB = tmp("real-b-");
    const restored = await restoreProfileArchive(
      dirB,
      chunks(archive, 4096),
      MAX,
    );
    const b = await launch(dirB);
    expect(await writeCookies(b.port, restored.cookies)).toBe(3);
    const got = (await evaluate(
      b.port,
      `http://127.0.0.1:${port}/read`,
      "JSON.stringify({ server: window.server, js: document.cookie, ls: window.ls, idb: window.idb })",
      "window.idb !== undefined",
    )) as string;
    expect(JSON.parse(got)).toEqual({
      server: "sess=s1; hard=h1",
      js: "sess=s1",
      ls: "v1",
      idb: "idb1",
    });
    const back = await readCookies(b.port);
    expect(back.find((c) => c.name === "part")?.partitionKey).toEqual(
      parsed.cookies.find((c) => c.name === "part")?.partitionKey,
    );
  }, 60_000);
});
