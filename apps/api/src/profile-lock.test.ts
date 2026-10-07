import { randomBytes } from "node:crypto";
import type { StartRequest } from "@kestrel/contracts";
import {
  ErrorResponse,
  ListEventsResponse,
  Profile,
  Session,
  idToUuid,
  type Report,
} from "@kestrel/contracts";
import { profileBlobKey } from "@kestrel/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { collectProfiles } from "./profile-sessions.js";
import { makeEnv, type Env, type EnvOptions } from "./test/harness.js";

/*
 * P18 (docs/lld/p18-profiles.md sections 4.1, 4.8 and 5) with the fake node, which seals and opens
 * real blobs in the test's profile store with the keys the API sends.
 */

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});
afterAll(async () => env?.close());

async function setup(
  opts: EnvOptions = { profiles: true, nodes: [{ id: "a", slots: 30 }] },
): Promise<Env> {
  env = await makeEnv(opts);
  return env;
}

const error = (res: { json(): unknown }) =>
  ErrorResponse.parse(res.json()).error;

async function newProfile(e: Env, key = e.key): Promise<Profile> {
  const res = await e.api.inject({
    method: "POST",
    url: "/v1/profiles",
    payload: {},
    headers: { authorization: `Bearer ${key}` },
  });
  expect(res.statusCode).toBe(201);
  return Profile.parse(res.json());
}

const getProfile = async (e: Env, id: string) =>
  Profile.parse((await e.call("GET", `/v1/profiles/${id}`)).json());

const types = async (e: Env, sessionId: string) =>
  ListEventsResponse.parse(
    (await e.call("GET", `/v1/sessions/${sessionId}/events?limit=1000`)).json(),
  ).data.map((x) => x.type);

const profileEvents = async (e: Env, sessionId: string) =>
  ListEventsResponse.parse(
    (await e.call("GET", `/v1/sessions/${sessionId}/events?limit=1000`)).json(),
  ).data.filter((x) => x.type.startsWith("profile."));

async function start(
  e: Env,
  profile: { id: string; persist?: boolean },
  extra: Record<string, unknown> = {},
): Promise<Session> {
  const res = await e.create({ profile, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return Session.parse(res.json());
}

async function stop(e: Env, s: Session): Promise<void> {
  expect((await e.call("POST", `/v1/sessions/${s.id}/stop`)).statusCode).toBe(
    200,
  );
  await e.syncAll();
}

const lastStart = (e: Env, node = "a"): StartRequest =>
  e.nodes[node]!.startCalls.at(-1)!;

describe("sessions with a profile", () => {
  it("writes a version, then starts readers and the next writer from it", async () => {
    const e = await setup();
    const p = await newProfile(e);

    const w1 = await start(e, { id: p.id, persist: true });
    expect(w1.startPath).toBe("hot");
    expect(w1.options.profile).toEqual({ id: p.id, persist: true });
    const req = lastStart(e);
    expect(req.profile?.restore).toBeUndefined();
    expect(req.profile?.save).toMatchObject({ version: 1 });
    expect((await getProfile(e, p.id)).inUseBy).toBe(w1.id);

    e.nodes.a!.profileArchive = Buffer.from("version one");
    await stop(e, w1);
    const v1 = await getProfile(e, p.id);
    expect(v1).toMatchObject({
      version: 1,
      chromeMajor: 154,
      inUseBy: null,
      savedBySessionId: w1.id,
    });
    expect(v1.bytes).toBeGreaterThan(64);
    expect(await profileEvents(e, w1.id)).toMatchObject([
      { type: "profile.saved", data: { profileId: p.id, version: 1 } },
    ]);

    // A reader starts warm from version 1: the node opened the blob with the key it was sent.
    const r = await start(e, { id: p.id });
    expect(r.startPath).toBe("warm");
    expect(lastStart(e).profile).toMatchObject({
      restore: { version: 1, chromeMajor: 154, bytes: v1.bytes },
    });
    expect(lastStart(e).profile?.save).toBeUndefined();
    expect(e.nodes.a!.restored.get(r.id)?.toString()).toBe("version one");
    expect((await getProfile(e, p.id)).inUseBy).toBeNull();

    // The next writer restores 1 and saves 2; 1 is superseded, kept for readers, then collected.
    const w2 = await start(e, { id: p.id, persist: true });
    expect(lastStart(e).profile).toMatchObject({
      restore: { version: 1 },
      save: { version: 2 },
    });
    e.nodes.a!.profileArchive = Buffer.from("version two");
    await stop(e, w2);
    expect((await getProfile(e, p.id)).version).toBe(2);
    const uuid = idToUuid(p.id);
    expect(
      (
        await e.db.profileVersion.findMany({
          where: { profileId: uuid },
          orderBy: { version: "asc" },
        })
      ).map((v) => v.state),
    ).toEqual(["superseded", "committed"]);

    const r2 = await start(e, { id: p.id });
    expect(e.nodes.a!.restored.get(r2.id)?.toString()).toBe("version two");

    // Collection: nothing before 10 minutes; then version 1's row and blob go.
    const store = e.ctx.profiles!.store;
    await collectProfiles(e.ctx, e.clock.now());
    expect(await store.list("")).toHaveLength(2);
    await collectProfiles(e.ctx, e.clock.now() + 11 * 60_000);
    expect((await store.list("")).map((b) => b.key)).toEqual([
      profileBlobKey(e.projectId, uuid, 2),
    ]);
    expect(
      await e.db.profileVersion.count({ where: { profileId: uuid } }),
    ).toBe(1);
  });

  it("sends the keys only in the start request, never in the session or its events", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    const key = lastStart(e).profile!.save!.key;
    expect(JSON.stringify(w)).not.toContain(key);
    await stop(e, w);
    const all = JSON.stringify(
      (await e.call("GET", `/v1/sessions/${w.id}/events?limit=1000`)).json(),
    );
    expect(all).not.toContain(key);
    const stored = await e.db.profileVersion.findFirstOrThrow({
      where: { profileId: idToUuid(p.id) },
    });
    expect(Buffer.from(stored.wrappedKey).toString("base64")).not.toBe(key);
    expect(
      Buffer.from(stored.wrappedKey).includes(Buffer.from(key, "base64")),
    ).toBe(false);
  });

  it("lets exactly one of 20 concurrent writers in, and readers alongside", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const writers = await Promise.all(
      Array.from({ length: 20 }, () =>
        e.create({ profile: { id: p.id, persist: true } }),
      ),
    );
    const readers = await Promise.all(
      Array.from({ length: 5 }, () => e.create({ profile: { id: p.id } })),
    );
    expect(writers.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of writers.filter((x) => x.statusCode !== 201)) {
      expect(r.statusCode).toBe(409);
      expect(error(r)).toMatchObject({
        code: "conflict",
        param: "profile.id",
        retryable: true,
      });
    }
    expect(readers.every((r) => r.statusCode === 201)).toBe(true);
    // No session row, lock or pending version leaked from the refused ones.
    expect(await e.db.session.count()).toBe(6);
    expect(
      await e.db.profileVersion.count({
        where: { profileId: idToUuid(p.id) },
      }),
    ).toBe(1);

    // Once the writer ends, a new writer gets in at once.
    const w = Session.parse(writers.find((r) => r.statusCode === 201)!.json());
    await stop(e, w);
    expect(
      (await e.create({ profile: { id: p.id, persist: true } })).statusCode,
    ).toBe(201);
  });

  it("answers not_found for another project's, a deleted or a malformed profile", async () => {
    const e = await setup();
    const mine = await newProfile(e);
    const theirs = await newProfile(e, e.project2.key);
    const gone = await newProfile(e);
    await e.call("DELETE", `/v1/profiles/${gone.id}`);
    for (const profile of [
      { id: theirs.id },
      { id: theirs.id, persist: true },
      { id: gone.id, persist: true },
      { id: gone.id },
    ]) {
      const res = await e.create({ profile });
      expect(res.statusCode).toBe(404);
      expect(error(res)).toMatchObject({ param: "profile.id" });
    }
    const bad = await e.create({ profile: { id: "prf_nope" } });
    expect(bad.statusCode).toBe(400);
    expect(
      (await e.create({ profile: { id: mine.id, persist: true } })).statusCode,
    ).toBe(201);
    expect(await e.db.session.count()).toBe(1);
  });

  it("is refused on a deployment without profiles", async () => {
    const e = await setup({});
    const res = await e.create({ profile: { id: `prf_${"0".repeat(26)}` } });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ param: "profile" });
  });

  it("puts the profile in the idempotency hash", async () => {
    const e = await setup();
    const a = await newProfile(e);
    const b = await newProfile(e);
    const first = await e.create({
      profile: { id: a.id },
      idempotencyKey: "k",
    });
    expect(first.statusCode).toBe(201);
    const same = await e.create({ profile: { id: a.id }, idempotencyKey: "k" });
    expect(same.statusCode).toBe(200);
    const other = await e.create({
      profile: { id: b.id },
      idempotencyKey: "k",
    });
    expect(other.statusCode).toBe(409);
    const persist = await e.create({
      profile: { id: a.id, persist: true },
      idempotencyKey: "k",
    });
    expect(persist.statusCode).toBe(409);
  });
});

describe("node choice", () => {
  async function saveOne(e: Env, p: Profile): Promise<void> {
    await stop(e, await start(e, { id: p.id, persist: true }));
    expect((await getProfile(e, p.id)).version).toBe(1);
  }

  it("needs a node with a Chrome at least as new as the one that saved", async () => {
    const e = await setup({
      profiles: true,
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    // Only a can take it at first: b is older.
    e.nodes.b!.chromeMajor = 150;
    await e.nodes.b!.register(e.internal);
    const p = await newProfile(e);
    e.nodes.b!.warmCount = 5;
    await e.syncAll();
    await saveOne(e, p);
    for (let i = 0; i < 3; i++) {
      const r = await start(e, { id: p.id });
      expect(r.nodeId).toBe("a");
    }
    // A node that never said its Chrome takes no profile session, even an empty one.
    e.nodes.a!.chromeMajor = 0;
    await e.nodes.a!.register(e.internal);
    await e.db.node.update({ where: { id: "a" }, data: { chromeMajor: 0 } });
    const none = await e.create({ profile: { id: p.id } });
    expect(none.statusCode).toBe(409);
    expect(error(none)).toMatchObject({
      code: "conflict",
      param: "profile.id",
      retryable: false,
    });
    const empty = await newProfile(e);
    const newer = await e.create({ profile: { id: empty.id } });
    expect(newer.statusCode).toBe(201);
    expect(Session.parse(newer.json()).nodeId).toBe("b");
    // Sessions without a profile are unaffected.
    expect((await e.create()).statusCode).toBe(201);
  });

  it("orders by warm browsers for a restore and hot ones otherwise", async () => {
    const e = await setup({
      profiles: true,
      nodes: [
        { id: "a", slots: 10 },
        { id: "b", slots: 10 },
      ],
    });
    const p = await newProfile(e);
    await saveOne(e, p);
    e.nodes.a!.hotCount = 5;
    e.nodes.a!.warmCount = 0;
    e.nodes.b!.hotCount = 0;
    e.nodes.b!.warmCount = 2;
    await e.syncAll();
    expect((await start(e, { id: p.id })).nodeId).toBe("b");
    expect(Session.parse((await e.create()).json()).nodeId).toBe("a");
    // An empty profile restores nothing: hot browsers order it.
    const empty = await newProfile(e);
    expect((await start(e, { id: empty.id })).nodeId).toBe("a");
    // The warm count is taken down at once, so a burst spreads.
    expect(
      (await e.db.node.findUniqueOrThrow({ where: { id: "b" } })).warmCount,
    ).toBe(1);
  });

  it("is full, not refused, when the right node merely has no room, and leaks no lock", async () => {
    const e = await setup({ profiles: true, nodes: [{ id: "a", slots: 1 }] });
    const p = await newProfile(e);
    await start(e, { id: p.id });
    const full = await e.create({ profile: { id: p.id, persist: true } });
    expect(full.statusCode).toBe(503);
    expect((await getProfile(e, p.id)).inUseBy).toBeNull();
    expect(
      await e.db.profileVersion.count({ where: { profileId: idToUuid(p.id) } }),
    ).toBe(0);
  });
});

describe("a reader racing a commit or a delete", () => {
  /**
   * Run `change` on another connection the first time the admission reads the profile with a
   * model query: the moment between reading the current version and reading its row, if the
   * admission makes two reads.
   */
  function between(e: Env, change: () => Promise<unknown>): void {
    let fired = false;
    e.ctx.db = e.db.$extends({
      query: {
        profile: {
          async findFirst({ args, query }) {
            const r = await query(args);
            if (!fired) {
              fired = true;
              await change();
            }
            return r;
          },
        },
      },
    }) as unknown as Env["db"];
  }

  it("starts from the version current when it read, even if a commit supersedes it at once", async () => {
    const e = await setup();
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    const uuid = idToUuid(p.id);
    const v1 = await e.db.profileVersion.findFirstOrThrow({
      where: { profileId: uuid, version: 1 },
    });
    between(e, () =>
      e.db.$transaction([
        e.db.profileVersion.update({
          where: { profileId_version: { profileId: uuid, version: 1 } },
          data: { state: "superseded", supersededAt: new Date() },
        }),
        e.db.profileVersion.create({
          data: { ...v1, version: 2, state: "committed" },
        }),
        e.db.profile.update({
          where: { id: uuid },
          data: { currentVersion: 2 },
        }),
      ]),
    );
    const res = await e.create({ profile: { id: p.id } });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("accepts a current version whose row is superseded (kept for readers)", async () => {
    const e = await setup();
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    await e.db.profileVersion.updateMany({
      where: { profileId: idToUuid(p.id) },
      data: { state: "superseded", supersededAt: new Date() },
    });
    const res = await e.create({ profile: { id: p.id } });
    expect(res.statusCode, res.body).toBe(201);
    expect(Session.parse(res.json()).startPath).toBe("warm");
  });

  it("answers not_found, never a 500, for a profile deleted while it is read", async () => {
    const e = await setup();
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    between(e, () => e.call("DELETE", `/v1/profiles/${p.id}`));
    const res = await e.create({ profile: { id: p.id } });
    expect([201, 404]).toContain(res.statusCode);
  });
});

describe("a profile that cannot be restored", () => {
  it("fails at once with profile_unavailable when the blob is gone", async () => {
    const e = await setup();
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    await e.ctx.profiles!.store.delete(
      profileBlobKey(e.projectId, idToUuid(p.id), 1),
    );
    const calls = e.nodes.a!.startCalls.length;
    const res = await e.create({ profile: { id: p.id } });
    expect(res.statusCode).toBe(500);
    expect(error(res)).toMatchObject({
      code: "internal",
      retryable: false,
      message: "The profile could not be restored.",
    });
    expect(e.nodes.a!.startCalls.length).toBe(calls + 1); // no second browser spent
    const s = await e.db.session.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      where: { endReason: "profile_unavailable" },
    });
    await e.syncAll();
    const row = await e.db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({
      status: "failed",
      endReason: "profile_unavailable",
    });
  });

  it("fails with profile_unavailable when its key does not unwrap", async () => {
    const e = await setup();
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    await e.db.profileVersion.updateMany({
      where: { profileId: idToUuid(p.id) },
      data: { wrappedKey: new Uint8Array(randomBytes(60)) },
    });
    const calls = e.nodes.a!.startCalls.length;
    const res = await e.create({ profile: { id: p.id } });
    expect(res.statusCode).toBe(500);
    expect(error(res).message).toBe("The profile could not be restored.");
    expect(e.nodes.a!.startCalls.length).toBe(calls); // never sent to a node
  });
});

describe("releasing the lock (section 5)", () => {
  const lockAndPending = async (e: Env, p: Profile) => ({
    inUseBy: (await getProfile(e, p.id)).inUseBy,
    pending: await e.db.profileVersion.count({
      where: { profileId: idToUuid(p.id), state: "pending" },
    }),
  });

  it("releases a writer that never became ready (not_started)", async () => {
    const e = await setup();
    const p = await newProfile(e);
    e.nodes.a!.startMode = "fail";
    const res = await e.create({ profile: { id: p.id, persist: true } });
    expect(res.statusCode).toBe(500);
    await e.syncAll();
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    const s = await e.db.session.findFirstOrThrow();
    const events = await e.db.sessionEvent.findMany({
      where: { sessionId: s.id, type: { startsWith: "profile." } },
    });
    expect(
      events.map((x) => [x.type, (x.data as { reason: string }).reason]),
    ).toEqual([["profile.save_failed", "not_started"]]);
  });

  it("releases on an unclean end, and on a save the node reports failed", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const crashed = await start(e, { id: p.id, persist: true });
    e.nodes.a!.expire(crashed.id, "browser_crash");
    await e.syncAll();
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    expect(await profileEvents(e, crashed.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "unclean_end" } },
    ]);

    e.nodes.a!.profileSave = "too_large";
    const big = await start(e, { id: p.id, persist: true });
    await stop(e, big);
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    expect(await profileEvents(e, big.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "too_large" } },
    ]);
    expect((await getProfile(e, p.id)).version).toBe(0);
  });

  it("releases a writer whose node was lost (node_lost), and ignores its late report", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    const run = async (seconds: number, beat: boolean) => {
      for (let t = 0; t < seconds; t++) {
        e.clock.advance(1_000);
        if (beat && t % 2 === 0) await e.syncAll();
        if (t % 5 === 0) await e.sweeper.tick();
      }
    };
    await run(10, true);
    await run(20, false);
    expect(
      (await e.db.node.findUniqueOrThrow({ where: { id: "a" } })).state,
    ).toBe("lost");
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    expect(await profileEvents(e, w.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "node_lost" } },
    ]);
    // The node comes back and its save arrives: stale, so nothing changes and no second event.
    await e.syncAll();
    await e.syncAll();
    expect((await getProfile(e, p.id)).version).toBe(0);
    expect(await profileEvents(e, w.id)).toHaveLength(1);
  });

  it("releases a writer already stopping when its node is lost, so the profile is not locked forever", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    const run = async (seconds: number, beat: boolean) => {
      for (let t = 0; t < seconds; t++) {
        e.clock.advance(1_000);
        if (beat && t % 2 === 0) await e.syncAll();
        if (t % 5 === 0) await e.sweeper.tick();
      }
    };
    await run(10, true);
    // The client stops it; the node accepts, then goes silent before reporting anything.
    expect((await e.call("POST", `/v1/sessions/${w.id}/stop`)).statusCode).toBe(
      200,
    );
    await new Promise((r) => setImmediate(r));
    expect((await e.db.session.findFirstOrThrow()).status).toBe("stopping");
    await run(20, false);
    expect(
      (await e.db.node.findUniqueOrThrow({ where: { id: "a" } })).state,
    ).toBe("lost");
    expect((await e.db.session.findFirstOrThrow()).status).toBe("stopped");
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    expect(await profileEvents(e, w.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "node_lost" } },
    ]);
  });

  it("releases a writer whose report was lost for good (no_report), after three heartbeats", async () => {
    const e = await setup();
    const p = await newProfile(e);
    e.nodes.a!.profileSave = "lost";
    const w = await start(e, { id: p.id, persist: true });
    await stop(e, w);
    expect((await e.db.session.findFirstOrThrow()).status).toBe("stopped");
    expect((await getProfile(e, p.id)).inUseBy).toBe(w.id); // waiting for the report
    e.clock.advance(4_000);
    await e.syncAll();
    expect((await getProfile(e, p.id)).inUseBy).toBe(w.id);
    e.clock.advance(3_000);
    await e.syncAll();
    expect(await lockAndPending(e, p)).toEqual({ inUseBy: null, pending: 0 });
    expect(await profileEvents(e, w.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "no_report" } },
    ]);
  });

  it("does not release while the node still has a save to report", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    expect((await e.call("POST", `/v1/sessions/${w.id}/stop`)).statusCode).toBe(
      200,
    );
    // The removal is delivered, the save is still sealing (it counts as pending).
    const node = e.nodes.a!;
    const removed = node.reports.filter((r) => r.kind === "removed");
    node.reports = node.reports.filter((r) => r.kind !== "removed");
    const sealing = (node as unknown as { saving: Promise<void>[] }).saving;
    expect(sealing).toHaveLength(1);
    await e.internal.inject({
      method: "POST",
      url: "/internal/nodes/reports",
      payload: { nodeId: "a", epoch: node.epoch, reports: removed },
      headers: { authorization: `Bearer ${node.secret}` },
    });
    e.clock.advance(10_000);
    await node.heartbeat(e.internal);
    expect((await getProfile(e, p.id)).inUseBy).toBe(w.id);
    await node.flushReports(e.internal);
    expect((await getProfile(e, p.id)).version).toBe(1);
  });

  it("refuses a stale report: the lock was released, so nothing is committed and no second event", async () => {
    const e = await setup();
    const p = await newProfile(e);
    e.nodes.a!.profileSave = "lost";
    const w = await start(e, { id: p.id, persist: true });
    const save = lastStart(e).profile!.save!;
    await stop(e, w);
    e.clock.advance(7_000);
    await e.syncAll();
    expect((await getProfile(e, p.id)).inUseBy).toBeNull();
    const late: Report = {
      id: "late-1",
      at: new Date(e.clock.now()).toISOString(),
      kind: "profile",
      sessionId: w.id,
      profileId: p.id,
      outcome: "saved",
      version: save.version,
      bytes: 100,
      sha256: "c".repeat(64),
    };
    e.nodes.a!.reports.push(late);
    await e.syncAll();
    expect((await getProfile(e, p.id)).version).toBe(0);
    expect(await profileEvents(e, w.id)).toHaveLength(1);
    // and the same report again changes nothing either
    e.nodes.a!.reports.push(late);
    await e.syncAll();
    expect(await profileEvents(e, w.id)).toHaveLength(1);
  });

  it("applies a repeated saved report once", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    await e.call("POST", `/v1/sessions/${w.id}/stop`);
    const node = e.nodes.a!;
    await Promise.all((node as unknown as { saving: Promise<void>[] }).saving);
    const reports = [...node.reports];
    expect(reports.map((r) => r.kind)).toEqual(["removed", "profile"]);
    const deliver = () =>
      e.internal.inject({
        method: "POST",
        url: "/internal/nodes/reports",
        payload: { nodeId: "a", epoch: node.epoch, reports },
        headers: { authorization: `Bearer ${node.secret}` },
      });
    expect((await deliver()).statusCode).toBe(200);
    expect((await deliver()).statusCode).toBe(200);
    const saved = await e.db.sessionEvent.findFirstOrThrow({
      where: { type: "profile.saved" },
    });
    expect(saved.dedupeKey).toMatch(/^a:r\d+$/);
    expect(await profileEvents(e, w.id)).toHaveLength(1);
    expect((await getProfile(e, p.id)).version).toBe(1);
  });

  it("gives a running writer its outcome when its profile is deleted, even if its report never comes", async () => {
    const e = await setup();
    const p = await newProfile(e);
    e.nodes.a!.profileSave = "lost";
    const w = await start(e, { id: p.id, persist: true });
    expect((await e.call("DELETE", `/v1/profiles/${p.id}`)).statusCode).toBe(
      204,
    );
    // Written with the deletion, while the writer still runs.
    expect(await profileEvents(e, w.id)).toMatchObject([
      {
        type: "profile.save_failed",
        data: { profileId: p.id, reason: "deleted" },
      },
    ]);
    await stop(e, w);
    e.clock.advance(10_000);
    await e.syncAll();
    expect(await profileEvents(e, w.id)).toHaveLength(1);
  });

  it("does not commit into a deleted profile, and collects the orphaned blob", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const w = await start(e, { id: p.id, persist: true });
    expect((await e.call("DELETE", `/v1/profiles/${p.id}`)).statusCode).toBe(
      204,
    );
    await stop(e, w);
    expect(await profileEvents(e, w.id)).toMatchObject([
      { type: "profile.save_failed", data: { reason: "deleted" } },
    ]);
    const store = e.ctx.profiles!.store;
    expect(await store.list("")).toHaveLength(1);
    await collectProfiles(e.ctx, Date.now());
    expect(await store.list("")).toHaveLength(1); // young: a report may still be on its way
    await collectProfiles(e.ctx, Date.now() + 2 * 60 * 60_000);
    expect(await store.list("")).toEqual([]);
  });

  it("refuses a save that would pass the project's bytes (project_quota)", async () => {
    const e = await setup();
    await e.db.project.update({
      where: { id: e.projectId },
      data: { maxProfileBytes: 50n },
    });
    const p = await newProfile(e);
    await stop(e, await start(e, { id: p.id, persist: true }));
    const saved = await e.db.sessionEvent.findMany({
      where: { type: { startsWith: "profile." } },
    });
    expect(saved.map((x) => (x.data as { reason?: string }).reason)).toEqual([
      "project_quota",
    ]);
    expect(await getProfile(e, p.id)).toMatchObject({
      version: 0,
      inUseBy: null,
    });
  });

  it("lets only one of two concurrent commits into one project pass its byte quota", async () => {
    const e = await setup({
      profiles: true,
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    // Each save is about 1,100 bytes (random, so gzip cannot shrink it); the project allows one.
    for (const n of Object.values(e.nodes))
      n.profileArchive = randomBytes(1000);
    await e.db.project.update({
      where: { id: e.projectId },
      data: { maxProfileBytes: 1500n },
    });
    const p1 = await newProfile(e);
    const p2 = await newProfile(e);
    const w1 = await start(e, { id: p1.id, persist: true });
    const w2 = await start(e, { id: p2.id, persist: true });
    expect([w1.nodeId, w2.nodeId].sort()).toEqual(["a", "b"]);
    for (const w of [w1, w2])
      expect(
        (await e.call("POST", `/v1/sessions/${w.id}/stop`)).statusCode,
      ).toBe(200);
    // Each commit waits after summing: without the project's lock both would pass.
    e.failpoints.set("api.profile.commit.after_sum", "stall:300");
    await Promise.all([
      e.nodes.a!.flushReports(e.internal),
      e.nodes.b!.flushReports(e.internal),
    ]);
    e.failpoints.clear();
    const outcomes = await e.db.sessionEvent.findMany({
      where: { type: { startsWith: "profile." } },
    });
    expect(outcomes.map((x) => x.type).sort()).toEqual([
      "profile.save_failed",
      "profile.saved",
    ]);
    expect(
      outcomes.find((x) => x.type === "profile.save_failed")?.data,
    ).toMatchObject({ reason: "project_quota" });
  });

  it("writes no profile event for a reader", async () => {
    const e = await setup();
    const p = await newProfile(e);
    const r = await start(e, { id: p.id });
    await stop(e, r);
    expect(await types(e, r.id)).not.toContain("profile.save_failed");
  });
});
