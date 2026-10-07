import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  PROFILE_LIMITS,
  encodeProfileArchive,
  encodeProfileArchiveHead,
  idToUuid,
  newId,
  parseProfileArchive,
  type Report,
  type StartRequest,
} from "@kestrel/contracts";
import {
  newDataKey,
  openProfileBlob,
  profileBlobKey,
  sealProfileBlob,
} from "@kestrel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSaved } from "./profile.js";
import {
  HttpRuntimeClient,
  ResponseTooLarge,
  type ProfileSaveAnswer,
} from "./runtime-client.js";
import { makeRig, prj, startReq, type Rig } from "./test/fakes.js";

/*
 * P18-7 (docs/lld/p18-profiles.md 4.4 and 4.7): the save at the end of a writer session, in the
 * teardown, with everything the browser answers taken as hostile (T-71).
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const MAX = 1024 * 1024;

function writer(over: Record<string, unknown> = {}): StartRequest {
  return startReq({
    projectId: prj(),
    profile: {
      profileId: newId("prf"),
      save: {
        version: 4,
        key: newDataKey().toString("base64"),
        maxBytes: MAX,
      },
    },
    ...over,
  });
}

async function rig(
  over: Parameters<typeof makeRig>[0] = {},
  opts: Parameters<typeof makeRig>[1] = {},
): Promise<Rig> {
  const r = makeRig(
    { chromeMajor: 154, profileSaveMs: 300, ...over },
    { profiles: true, ...opts },
  );
  await r.agent.boot();
  await r.agent.refillPool();
  await r.agent.idle();
  return r;
}

const profileReports = (r: Rig, sessionId?: string) =>
  [...r.store.pendingReports(1000), ...r.api.allReports].filter(
    (x): x is Extract<Report, { kind: "profile" }> =>
      x.kind === "profile" &&
      (sessionId === undefined || x.sessionId === sessionId),
  );

async function run(r: Rig, req: StartRequest) {
  const res = await r.agent.start(req);
  expect(res).toMatchObject({ result: "ready" });
  return r.store.getBinding(req.sessionId)!;
}

async function stop(r: Rig, id: string, reason = "client_stop") {
  await r.agent.stop({ sessionId: id, reason } as never);
  await r.agent.idle();
}

describe("a writer's save", () => {
  it("is pulled after the route and the policy are gone, before the browser is, then sealed and reported once", async () => {
    const r = await rig();
    const req = writer();
    const b = await run(r, req);
    let seen: Record<string, boolean> = {};
    r.runtime.saveAnswers.set(b.address!, async () => {
      seen = {
        route: r.hub.routes.has(req.sessionId),
        policy: r.egress.policies.has(b.address!),
        container: r.docker.containers.has(b.containerId!),
      };
      return {
        ok: true,
        body: encodeProfileArchive(
          [],
          [{ path: "Default/LocalStorage", data: Buffer.from("state") }],
        ),
      };
    });
    await stop(r, req.sessionId);
    expect(seen).toEqual({ route: false, policy: false, container: true });
    expect(r.docker.containers.has(b.containerId!)).toBe(false);

    const reports = r.store.pendingReports(100);
    const removed = reports.findIndex((x) => x.kind === "removed");
    const saved = reports.findIndex((x) => x.kind === "profile");
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(saved).toBeGreaterThan(removed); // the slot goes first
    const report = profileReports(r)[0]!;
    expect(report).toMatchObject({
      outcome: "saved",
      version: 4,
      profileId: req.profile!.profileId,
    });

    // The blob is where the ids say, opens with the save key, and holds what the browser sent.
    const ids = {
      projectUuid: idToUuid(req.projectId),
      profileUuid: idToUuid(req.profile!.profileId),
      version: 4,
    };
    const blob = await r.profileStore!.get(
      profileBlobKey(ids.projectUuid, ids.profileUuid, 4),
      report.bytes!,
    );
    expect(createHash("sha256").update(blob).digest("hex")).toBe(report.sha256);
    const archive = await openProfileBlob(
      Buffer.from(req.profile!.save!.key, "base64"),
      ids,
      blob,
      10 * MAX,
    );
    expect(parseProfileArchive(archive, MAX).files[0]!.data.toString()).toBe(
      "state",
    );
    // The save, and its key, are gone from the agent's store, its files included: the
    // write-ahead log too, as the agent leaves it (no checkpoint here).
    expect(r.store.allProfileSaves()).toEqual([]);
    const keyBytes = Buffer.from(req.profile!.save!.key);
    for (const f of readdirSync(dirname(r.dbPath)))
      expect(
        readFileSync(join(dirname(r.dbPath), f)).includes(keyBytes),
        f,
      ).toBe(false);
  });

  it("is not attempted after an unclean end, for a reader, or for a writer that never started", async () => {
    const r = await rig();
    const crashed = writer();
    const b = await run(r, crashed);
    r.docker.kill(b.containerId!);
    await r.agent.reconcile();
    await r.agent.idle();
    expect(profileReports(r, crashed.sessionId)).toMatchObject([
      { outcome: "failed", reason: "unclean_end" },
    ]);

    const reader = startReq({ profile: { profileId: newId("prf") } });
    await run(r, reader);
    await stop(r, reader.sessionId);
    expect(profileReports(r, reader.sessionId)).toEqual([]);

    r.runtime.failAllConfigures = true;
    const never = writer();
    expect(await r.agent.start(never)).toMatchObject({ result: "failed" });
    expect(profileReports(r, never.sessionId)).toMatchObject([
      { outcome: "failed", reason: "not_started" },
    ]);
    expect(r.runtime.saveCalls).toEqual([]);
    expect(r.store.allProfileSaves()).toEqual([]);
  });

  it("refuses every hostile answer (T-71), writes nothing, and reports why", async () => {
    const big = (n: number) => Buffer.alloc(n, 1);
    const longManifest = (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(PROFILE_LIMITS.manifestBytes + 1);
      return b;
    })();
    const good = encodeProfileArchive(
      [],
      [{ path: "Default/LocalStorage", data: Buffer.from("x") }],
    );
    const cases: [string, ProfileSaveAnswer | "hang" | "fail", string][] = [
      [
        "dot-dot path",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/IndexedDB/../../../etc/passwd", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "absolute path",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "/etc/shadow", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "Preferences",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/Preferences", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "Local State",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Local State", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "an extension",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/Extensions/abc/1/manifest.json", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "a service worker",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/Service Worker/ScriptCache/x", data: big(1) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "a LevelDB lock",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/IndexedDB/o/LOCK", data: big(0) }],
          ),
        },
        "invalid_archive",
      ],
      [
        "a file that is also a directory",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [
              { path: "Default/IndexedDB/a", data: big(1) },
              { path: "Default/IndexedDB/a/b", data: big(1) },
            ],
          ),
        },
        "invalid_archive",
      ],
      [
        "one byte short",
        { ok: true, body: good.subarray(0, good.length - 1) },
        "invalid_archive",
      ],
      [
        "one byte over",
        { ok: true, body: Buffer.concat([good, big(1)]) },
        "invalid_archive",
      ],
      ["a manifest past 1 MiB", { ok: true, body: longManifest }, "too_large"],
      [
        "not an archive",
        {
          ok: true,
          body: Buffer.concat([
            Buffer.from([0, 0, 0, 5]),
            Buffer.from("hello"),
          ]),
        },
        "invalid_archive",
      ],
      [
        "a forged cookie count",
        {
          ok: true,
          body: Buffer.concat([
            encodeProfileArchiveHead({
              format: 1,
              cookies: { bytes: 2, count: 3 },
              files: [],
            }),
            Buffer.from("[]"),
          ]),
        },
        "invalid_archive",
      ],
      [
        "cookies that are not cookies",
        {
          ok: true,
          body: Buffer.concat([
            encodeProfileArchiveHead({
              format: 1,
              cookies: { bytes: 13, count: 1 },
              files: [],
            }),
            Buffer.from('[{"name":1}]'),
          ]),
        },
        "invalid_archive",
      ],
      [
        "a size bomb in the manifest",
        {
          ok: true,
          body: encodeProfileArchiveHead({
            format: 1,
            cookies: { bytes: 0, count: 0 },
            files: [{ path: "Default/LocalStorage", bytes: 200 * 1024 * 1024 }],
          }),
        },
        "too_large",
      ],
      [
        "past the save's cap",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            [{ path: "Default/LocalStorage", data: big(MAX + 1) }],
          ),
        },
        "too_large",
      ],
      [
        "a count bomb",
        {
          ok: true,
          body: encodeProfileArchive(
            [],
            Array.from({ length: 4097 }, (_, i) => ({
              path: `Default/IndexedDB/o/${i}`,
              data: big(0),
            })),
          ),
        },
        "too_large",
      ],
      ["413", { ok: false, status: 413, code: "too_large" }, "too_large"],
      [
        "409 unclean",
        { ok: false, status: 409, code: "unclean" },
        "chrome_did_not_exit",
      ],
      ["500", { ok: false, status: 500, code: "" }, "invalid_archive"],
      ["a stall", "hang", "timeout"],
      ["a reset", "fail", "browser_gone"],
    ];
    const r = await rig({ slotsTotal: 30, poolTarget: 0 });
    for (const [name, answer, reason] of cases) {
      const req = writer();
      const b = await run(r, req);
      r.runtime.saveAnswers.set(b.address!, answer);
      const t0 = Date.now();
      await stop(r, req.sessionId);
      expect(Date.now() - t0, name).toBeLessThan(5_000);
      expect(profileReports(r, req.sessionId), name).toMatchObject([
        { outcome: "failed", reason },
      ]);
      expect(r.docker.containers.has(b.containerId!), name).toBe(false);
    }
    expect(await r.profileStore!.list("")).toEqual([]);
    expect(r.store.allProfileSaves()).toEqual([]);
  });

  it("does not hold up another session's teardown while one waits on its save", async () => {
    const r = await rig({ profileSaveMs: 2_000 });
    const slow = writer();
    const fast = writer();
    const s = await run(r, slow);
    await run(r, fast);
    r.runtime.saveAnswers.set(s.address!, "hang");
    void r.agent.stop({
      sessionId: slow.sessionId,
      reason: "client_stop",
    } as never);
    void r.agent.stop({
      sessionId: fast.sessionId,
      reason: "client_stop",
    } as never);
    const until = Date.now() + 1_000;
    while (r.store.getBinding(fast.sessionId) && Date.now() < until)
      await new Promise((x) => setTimeout(x, 10));
    expect(r.store.getBinding(fast.sessionId)).toBeUndefined();
    expect(r.store.getBinding(slow.sessionId)).toBeDefined();
    await r.agent.idle();
    expect(profileReports(r, slow.sessionId)).toMatchObject([
      { outcome: "failed", reason: "timeout" },
    ]);
  });

  it("holds at most four archives at once, pull to write, and seals off the slot's path", async () => {
    const r = await rig({ slotsTotal: 8, poolTarget: 0, profileSaveMs: 5_000 });
    const store = r.profileStore!;
    const put = store.put.bind(store);
    // An archive is held from the moment the browser is asked for it until it is written.
    let held = 0;
    let most = 0;
    let release!: () => void;
    const gate = new Promise<void>((x) => (release = x));
    store.put = async (k, d) => {
      await gate;
      await put(k, d);
      held--;
    };
    const reqs = Array.from({ length: 6 }, () => writer());
    for (const q of reqs) await run(r, q);
    for (const q of reqs)
      r.runtime.saveAnswers.set(
        r.store.getBinding(q.sessionId)!.address!,
        async () => {
          held++;
          most = Math.max(most, held);
          return {
            ok: true,
            body: encodeProfileArchive(
              [],
              [{ path: "Default/LocalStorage", data: Buffer.from("state") }],
            ),
          };
        },
      );
    for (const q of reqs)
      await r.agent.stop({
        sessionId: q.sessionId,
        reason: "client_stop",
      } as never);
    // Four pulled, their browsers gone and slots free while their saves wait to be written; the
    // other two wait their turn, within their budget, before asking their browsers.
    const until = Date.now() + 2_000;
    while (r.store.allBindings().length > 2 && Date.now() < until)
      await new Promise((x) => setTimeout(x, 10));
    await new Promise((x) => setTimeout(x, 50));
    expect(r.store.allBindings()).toHaveLength(2);
    expect(r.runtime.saveCalls).toHaveLength(4);
    expect(most).toBe(4);
    expect(r.agent.describe().pendingReports).toBe(
      r.store.pendingReportCount() + 4,
    );
    release();
    await r.agent.idle();
    expect(most).toBe(4);
    expect(reqs.map((q) => profileReports(r, q.sessionId)[0]?.outcome)).toEqual(
      Array(6).fill("saved"),
    );
    expect(r.agent.describe().pendingReports).toBe(
      r.store.pendingReportCount(),
    );
  });

  it("fails a save that cannot get its turn within the budget, without asking its browser", async () => {
    const r = await rig({ profileSavesAtOnce: 1, profileSaveMs: 300 });
    const store = r.profileStore!;
    const put = store.put.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((x) => (release = x));
    store.put = async (k, d) => {
      await gate;
      await put(k, d);
    };
    const first = writer();
    const second = writer();
    await run(r, first);
    const b = await run(r, second);
    await r.agent.stop({
      sessionId: first.sessionId,
      reason: "client_stop",
    } as never);
    const t0 = Date.now();
    await r.agent.stop({
      sessionId: second.sessionId,
      reason: "client_stop",
    } as never);
    while (r.store.getBinding(second.sessionId) && Date.now() - t0 < 2_000)
      await new Promise((x) => setTimeout(x, 10));
    // its slot is free at the end of its budget, not when the first save is written
    expect(r.store.getBinding(second.sessionId)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.runtime.saveCalls).not.toContain(b.address);
    expect(profileReports(r, second.sessionId)).toMatchObject([
      { outcome: "failed", reason: "timeout" },
    ]);
    release();
    await r.agent.idle();
    expect(profileReports(r, first.sessionId)).toMatchObject([
      { outcome: "saved" },
    ]);
  });

  it("fails storage_full when the store is out of space, and keeps nothing", async () => {
    const r = await rig();
    r.profileStore!.put = async () => {
      const { ProfileStoreError } = await import("@kestrel/shared");
      throw new ProfileStoreError("storage_full", "put: ENOSPC");
    };
    const req = writer();
    await run(r, req);
    await stop(r, req.sessionId);
    expect(profileReports(r, req.sessionId)).toMatchObject([
      { outcome: "failed", reason: "storage_full" },
    ]);
  });
});

describe("a save across an agent restart", () => {
  it("ends saves left behind even on a node that no longer has a profile store", async () => {
    const r = makeRig({ chromeMajor: 154 });
    const written = writer();
    const pulled = writer();
    for (const q of [written, pulled])
      r.store.addProfileSave({
        sessionId: q.sessionId,
        projectId: q.projectId,
        profileId: q.profile!.profileId,
        version: 4,
        saveKey: q.profile!.save!.key,
        maxBytes: MAX,
      });
    r.store.advanceProfileSave(written.sessionId, "pending", "written", {
      bytes: 99,
      sha256: "a".repeat(64),
    });
    r.store.advanceProfileSave(pulled.sessionId, "pending", "pulled");
    expect(r.agent.describe().pendingReports).toBe(2);
    await r.agent.boot();
    expect(profileReports(r, written.sessionId)).toMatchObject([
      { outcome: "saved", bytes: 99 },
    ]);
    expect(profileReports(r, pulled.sessionId)).toMatchObject([
      { outcome: "failed", reason: "storage_error" },
    ]);
    // nothing left: no key in the store, no report counted as still to come
    expect(r.store.allProfileSaves()).toEqual([]);
    expect(r.agent.describe().pendingReports).toBe(
      r.store.pendingReportCount(),
    );
  });

  it("asks the browser again when the agent died after the pull, and reports once", async () => {
    const r = await rig(
      {},
      { failpoints: "node.profile.after_pull=throw:once" },
    );
    const req = writer();
    const b = await run(r, req);
    await stop(r, req.sessionId);
    // died at the failpoint: the binding is still stopping, its browser alive
    expect(r.store.getBinding(req.sessionId)?.state).toBe("stopping");
    expect(r.docker.containers.has(b.containerId!)).toBe(true);
    expect(r.store.getProfileSave(req.sessionId)?.state).toBe("pulled");
    r.restart();
    await r.agent.boot();
    await r.agent.idle();
    expect(r.runtime.saveCalls.filter((a) => a === b.address)).toHaveLength(2);
    expect(profileReports(r, req.sessionId)).toMatchObject([
      { outcome: "saved" },
    ]);
    await r.agent.flushReports();
    await r.agent.boot();
    await r.agent.idle();
    expect(profileReports(r, req.sessionId)).toHaveLength(1);
  });

  it("only queues the report when the agent died after writing", async () => {
    const r = await rig(
      {},
      { failpoints: "node.profile.after_write=throw:once" },
    );
    const req = writer();
    await run(r, req);
    await stop(r, req.sessionId);
    const s = r.store.getProfileSave(req.sessionId)!;
    expect(s.state).toBe("written");
    expect(profileReports(r, req.sessionId)).toEqual([]);
    // a save still to report counts as one
    expect(r.agent.describe().pendingReports).toBe(
      r.store.pendingReportCount() + 1,
    );
    r.restart();
    await r.agent.boot();
    expect(profileReports(r, req.sessionId)).toMatchObject([
      { outcome: "saved", bytes: s.bytes, sha256: s.sha256 },
    ]);
    expect(r.store.allProfileSaves()).toEqual([]);
  });

  it("reads back a version already written before the crash, and reports its length and digest", async () => {
    const r = await rig();
    const req = writer();
    const ids = {
      projectUuid: idToUuid(req.projectId),
      profileUuid: idToUuid(req.profile!.profileId),
      version: 4,
    };
    const key = Buffer.from(req.profile!.save!.key, "base64");
    const blob = await sealProfileBlob(key, ids, encodeProfileArchive([], []));
    const k = profileBlobKey(ids.projectUuid, ids.profileUuid, 4);
    await r.profileStore!.put(k, blob);
    // the save as a crash between the write and the store's update leaves it: its session gone
    r.store.addProfileSave({
      sessionId: req.sessionId,
      projectId: req.projectId,
      profileId: req.profile!.profileId,
      version: 4,
      saveKey: req.profile!.save!.key,
      maxBytes: MAX,
    });
    r.store.advanceProfileSave(req.sessionId, "pending", "pulled");
    r.restart();
    await r.agent.boot();
    expect(profileReports(r, req.sessionId)).toMatchObject([
      {
        outcome: "saved",
        bytes: blob.length,
        sha256: createHash("sha256").update(blob).digest("hex"),
      },
    ]);
    // never replaced
    expect((await r.profileStore!.get(k, blob.length)).equals(blob)).toBe(true);
  });

  it("fails a save whose browser is gone with the crash, and one whose version is not its own", async () => {
    const r = await rig();
    const gone = writer();
    const forged = writer();
    for (const q of [gone, forged])
      r.store.addProfileSave({
        sessionId: q.sessionId,
        projectId: q.projectId,
        profileId: q.profile!.profileId,
        version: 4,
        saveKey: q.profile!.save!.key,
        maxBytes: MAX,
      });
    // something under the forged one's version, not sealed with its key
    const ids = {
      projectUuid: idToUuid(forged.projectId),
      profileUuid: idToUuid(forged.profile!.profileId),
      version: 4,
    };
    await r.profileStore!.put(
      profileBlobKey(ids.projectUuid, ids.profileUuid, 4),
      await sealProfileBlob(newDataKey(), ids, randomBytes(10)),
    );
    r.restart();
    await r.agent.boot();
    expect(profileReports(r, gone.sessionId)).toMatchObject([
      { outcome: "failed", reason: "browser_gone" },
    ]);
    expect(profileReports(r, forged.sessionId)).toMatchObject([
      { outcome: "failed", reason: "storage_error" },
    ]);
  });
});

describe("checking a save without copying it", () => {
  it("checks every rule without copying a file's bytes", () => {
    const body = encodeProfileArchive(
      [],
      [{ path: "Default/LocalStorage", data: Buffer.alloc(2 * MAX, 7) }],
    );
    const concat = vi.spyOn(Buffer, "concat");
    try {
      expect(checkSaved(body, 4 * MAX)).toBe(body);
      const copied = concat.mock.calls.map((c) =>
        (c[0] as Uint8Array[]).reduce((n, b) => n + b.length, 0),
      );
      expect(copied.filter((n) => n >= MAX)).toEqual([]);
    } finally {
      concat.mockRestore();
    }
  });
});

describe("the runtime client's save call", () => {
  async function server(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<HttpRuntimeClient> {
    const s = createServer(handler);
    await new Promise<void>((x) => s.listen(0, "127.0.0.1", x));
    servers.push(s);
    return new HttpRuntimeClient((s.address() as AddressInfo).port);
  }
  const signal = () => AbortSignal.timeout(2_000);

  it("reads at most the largest archive the cap allows", async () => {
    const c = await server((_q, res) => {
      res.writeHead(200);
      res.end(
        Buffer.alloc(
          4 +
            PROFILE_LIMITS.manifestBytes +
            PROFILE_LIMITS.cookiesBytes +
            1024 +
            1,
        ),
      );
    });
    await expect(
      c.saveProfile("127.0.0.1", "t", 1024, signal()),
    ).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("never follows a redirect", async () => {
    let followed = false;
    const c = await server((q, res) => {
      if (q.url === "/elsewhere") {
        followed = true;
        return res.end("x");
      }
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });
    await expect(
      c.saveProfile("127.0.0.1", "t", 1024, signal()),
    ).rejects.toThrow();
    expect(followed).toBe(false);
  });

  it("gives up on a guest that stalls, at the save's deadline", async () => {
    const c = await server((_q, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(10)); // a few bytes, then nothing
    });
    const t0 = Date.now();
    await expect(
      c.saveProfile("127.0.0.1", "t", 1024, AbortSignal.timeout(200)),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("reads an archive of a stated length into one buffer, not chunks copied into another", async () => {
    const body = encodeProfileArchive(
      [],
      [{ path: "Default/LocalStorage", data: Buffer.alloc(MAX, 3) }],
    );
    const c = await server((_q, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      // in pieces, as a network delivers it
      for (let i = 0; i < body.length; i += 64 * 1024)
        res.write(body.subarray(i, i + 64 * 1024));
      res.end();
    });
    const concat = vi.spyOn(Buffer, "concat");
    try {
      const got = await c.saveProfile("127.0.0.1", "t", 2 * MAX, signal());
      expect(got.ok && got.body.equals(body)).toBe(true);
      const copied = concat.mock.calls.map((x) =>
        (x[0] as Uint8Array[]).reduce((n, b) => n + b.length, 0),
      );
      expect(copied.filter((n) => n >= MAX)).toEqual([]);
    } finally {
      concat.mockRestore();
    }
  });

  it("refuses a stated length past the cap before reading the body", async () => {
    const big = await server((_q, res) => {
      res.writeHead(200, {
        "content-length": String(
          4 + PROFILE_LIMITS.manifestBytes + PROFILE_LIMITS.cookiesBytes + 2048,
        ),
      });
      res.end();
    });
    await expect(
      big.saveProfile("127.0.0.1", "t", 1024, signal()),
    ).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("passes a refusal's status and code on, and an archive's exact bytes", async () => {
    const body = encodeProfileArchive([], []);
    let n = 0;
    const c = await server((q, res) => {
      expect(q.method).toBe("POST");
      expect(q.headers.authorization).toBe("Bearer t");
      if (n++ === 0) {
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unclean", message: "x" }));
      }
      res.writeHead(200);
      res.end(body);
    });
    expect(await c.saveProfile("127.0.0.1", "t", 1024, signal())).toEqual({
      ok: false,
      status: 409,
      code: "unclean",
    });
    const ok = await c.saveProfile("127.0.0.1", "t", 1024, signal());
    expect(ok.ok && ok.body.equals(body)).toBe(true);
  });
});
