import { createHash, randomBytes } from "node:crypto";
import {
  AgentState,
  encodeProfileArchive,
  idToUuid,
  newId,
  type StartProfile,
} from "@kestrel/contracts";
import {
  newDataKey,
  profileBlobKey,
  sealProfileBlob,
  type ProfileStore,
} from "@kestrel/shared";
import { describe, expect, it } from "vitest";
import { buildContainerSpec } from "./docker.js";
import { WarmCloneError } from "./microvm.js";
import { makeRig, prj, startReq, SPEC, type Rig } from "./test/fakes.js";

/*
 * P18-7 (docs/lld/p18-profiles.md 4.1 and 4.2): the warm pool level, and a start that restores a
 * profile: read, check and decrypt the blob, take a warm browser (else make one), write the
 * profile in, launch Chrome on it, and report it restored.
 */

const ARCHIVE = encodeProfileArchive(
  [
    {
      name: "sid",
      value: "v",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ],
  [{ path: "Default/LocalStorage", data: Buffer.from("local storage") }],
);

/** A saved version in the rig's store, and the `StartRequest.profile` that restores it. */
async function savedVersion(
  store: ProfileStore,
  projectId: string,
  version = 3,
  archive: Buffer = ARCHIVE,
): Promise<StartProfile> {
  const profileId = newId("prf");
  const key = newDataKey();
  const ids = {
    projectUuid: idToUuid(projectId),
    profileUuid: idToUuid(profileId),
    version,
  };
  const blob = await sealProfileBlob(key, ids, archive);
  await store.put(
    profileBlobKey(ids.projectUuid, ids.profileUuid, version),
    blob,
  );
  return {
    profileId: profileId as never,
    restore: {
      version,
      chromeMajor: 154,
      bytes: blob.length,
      sha256: createHash("sha256").update(blob).digest("hex"),
      key: key.toString("base64"),
    },
  };
}

async function rig(over: Parameters<typeof makeRig>[0] = {}): Promise<Rig> {
  const r = makeRig(
    { chromeMajor: 154, warmPool: 1, ...over },
    { profiles: true },
  );
  await r.agent.boot();
  await r.agent.refillPool();
  await r.agent.idle();
  await r.agent.refillPool();
  await r.agent.idle();
  return r;
}

const warmPool = (r: Rig) =>
  r.store.allPool().filter((p) => p.level === "warm" && p.state === "hot");

describe("the warm pool level", () => {
  it("is a container with Chrome deferred, labelled warm; otherwise the same profile", () => {
    const hot = buildContainerSpec(SPEC, "pool", "t".repeat(48));
    const warm = buildContainerSpec(
      SPEC,
      "pool",
      "t".repeat(48),
      undefined,
      "warm",
    );
    expect(warm.Env).toEqual([...(hot.Env ?? []), "KESTREL_CHROME=deferred"]);
    expect(warm.Labels).toEqual({ ...hot.Labels, "kestrel.level": "warm" });
    expect(warm.HostConfig).toEqual(hot.HostConfig);
  });

  it("is kept and refilled within the slots, beside the hot pool, and reported", async () => {
    const r = await rig({ slotsTotal: 4, poolTarget: 2, warmPool: 1 });
    expect(warmPool(r)).toHaveLength(1);
    expect(
      r.store.allPool().filter((p) => p.level === "hot" && p.state === "hot"),
    ).toHaveLength(2);
    const d = r.agent.describe();
    expect(d).toMatchObject({ hotCount: 2, warmCount: 1 });
    // A warm container runs with Chrome deferred.
    const id = warmPool(r)[0]!.containerId;
    expect(r.docker.specs.get(id)?.Env).toContain("KESTREL_CHROME=deferred");

    // Sessions have the slots first: with three running, one is left, and the hot pool takes it.
    const s = makeRig({ slotsTotal: 2, poolTarget: 2, warmPool: 1 });
    await s.agent.boot();
    for (let i = 0; i < 3; i++) {
      await s.agent.refillPool();
      await s.agent.idle();
    }
    expect(s.store.allPool()).toHaveLength(2);
    expect(s.store.allPool().every((p) => p.level === "hot")).toBe(true);
  });

  it("is kept only on a node that takes profile sessions (a store and a Chrome version)", async () => {
    const warmMade = async (r: Rig) => {
      await r.agent.boot();
      for (let i = 0; i < 3; i++) {
        await r.agent.refillPool();
        await r.agent.idle();
      }
      return r.store.allPool().filter((p) => p.level === "warm").length;
    };
    expect(await warmMade(makeRig({ warmPool: 1 }))).toBe(0);
    expect(await warmMade(makeRig({ warmPool: 1 }, { profiles: true }))).toBe(
      0,
    );
    expect(await warmMade(makeRig({ warmPool: 1, chromeMajor: 154 }))).toBe(0);
    expect(
      await warmMade(
        makeRig({ warmPool: 1, chromeMajor: 154 }, { profiles: true }),
      ),
    ).toBe(1);
  });

  it("is never taken by a session without a profile", async () => {
    const r = await rig({ poolTarget: 0, warmPool: 1 });
    const res = await r.agent.start(startReq());
    expect(res).toMatchObject({ result: "ready", startPath: "cold" });
    expect(warmPool(r)).toHaveLength(1);
  });

  it("is in the invariant checker's account: each browser's level, the target and what is wanted now", async () => {
    const r = await rig({ slotsTotal: 4, poolTarget: 1, warmPool: 1 });
    const st = AgentState.parse(r.agent.state());
    expect(
      st.pool.map((p) => p.level).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["hot", "warm"]);
    expect(st.warm).toEqual({ target: 1, wanted: 1 });
    // Restores in the demand window raise what is wanted, as starts do for the hot pool.
    const projectId = prj();
    for (let i = 0; i < 2; i++)
      await r.agent.start(
        startReq({
          projectId,
          profile: await savedVersion(r.profileStore!, projectId),
        }),
      );
    expect(r.agent.state().warm).toEqual({ target: 1, wanted: 2 });
    // A node that keeps no warm browsers wants none, whatever it was asked to restore.
    const none = await rig({ warmPool: 0 });
    expect(none.agent.state().warm).toEqual({ target: 0, wanted: 0 });
    expect(none.agent.state().pool.every((p) => p.level === "hot")).toBe(true);
    // Nor does a node without profiles, whatever WARM_POOL says: the target is the one it keeps.
    const off = makeRig({ warmPool: 1 });
    await off.agent.boot();
    expect(off.agent.state().warm).toEqual({ target: 0, wanted: 0 });
  });

  it("tells the API its Chrome at registration", async () => {
    const r = await rig();
    await r.agent.register();
    expect(r.api.registered.at(-1)).toMatchObject({ chromeMajor: 154 });
    const old = makeRig();
    await old.agent.register();
    expect(old.api.registered.at(-1)?.chromeMajor).toBeUndefined();
  });
});

describe("a start that restores a profile", () => {
  it("takes a warm browser, writes the profile, launches Chrome on it, and reports it restored", async () => {
    const r = await rig();
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const warm = warmPool(r)[0]!;
    const res = await r.agent.start(
      startReq({ projectId, profile, viewport: { width: 1024, height: 700 } }),
    );
    expect(res).toMatchObject({ result: "ready", startPath: "warm" });
    expect(r.runtime.profiles.get(warm.address)).toEqual(ARCHIVE);
    const ops = r.runtime.calls
      .filter((c) => c.address === warm.address)
      .map((c) => c.op);
    // the profile goes in before Chrome starts, and both before configure
    expect(ops.indexOf("putProfile")).toBeLessThan(
      ops.indexOf("launch:1024x700"),
    );
    expect(ops.indexOf("launch:1024x700")).toBeLessThan(
      ops.indexOf("configure"),
    );
    // and the policy before any of it (G7)
    expect(r.egress.log[0]).toBe(`set ${warm.address}`);
    const restored = r.store
      .pendingReports()
      .find((x) => x.kind === "event" && x.event.type === "profile.restored");
    expect(restored).toMatchObject({
      event: {
        data: {
          profileId: profile.profileId,
          version: 3,
          bytes: profile.restore!.bytes,
        },
      },
    });
    // The restore key is nowhere in the agent's store.
    const db = r.store.db
      .prepare("SELECT * FROM sessions")
      .all()
      .map((x) => JSON.stringify(x))
      .join();
    expect(db).not.toContain(profile.restore!.key);
  });

  it("makes a warm browser when none is pooled, and still reports the warm path", async () => {
    const r = await rig({ warmPool: 0 });
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const before = r.docker.runCalls;
    const res = await r.agent.start(startReq({ projectId, profile }));
    expect(res).toMatchObject({ result: "ready", startPath: "warm" });
    expect(r.docker.runCalls).toBeGreaterThan(before);
    const b = r.store.allBindings()[0]!;
    expect(r.docker.specs.get(b.containerId!)?.Env).toContain(
      "KESTREL_CHROME=deferred",
    );
  });

  it("starts a recording profile session cold, in a warm browser with a volume", async () => {
    const r = makeRig(
      { chromeMajor: 154, warmPool: 1 },
      { profiles: true, volumes: true },
    );
    await r.agent.boot();
    await r.agent.refillPool();
    await r.agent.idle();
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const res = await r.agent.start(
      startReq({ projectId, profile, recording: true }),
    );
    expect(res).toMatchObject({ result: "ready", startPath: "warm" });
    const b = r.store.allBindings()[0]!;
    const spec = r.docker.specs.get(b.containerId!);
    expect(spec?.Env).toContain("KESTREL_CHROME=deferred");
    expect(spec?.Labels?.["kestrel.volume"]).toBeDefined();
  });

  it("fails at once with profile_unavailable, spending no browser, for a damaged, swapped or missing blob", async () => {
    const r = await rig();
    const projectId = prj();
    const good = await savedVersion(r.profileStore!, projectId);
    const other = await savedVersion(
      r.profileStore!,
      projectId,
      3,
      Buffer.from("x"),
    );
    const cases: StartProfile[] = [
      // the digest does not match
      { ...good, restore: { ...good.restore!, sha256: "0".repeat(64) } },
      // the length does not match
      {
        ...good,
        restore: { ...good.restore!, bytes: good.restore!.bytes + 1 },
      },
      // another version's key
      { ...good, restore: { ...good.restore!, key: other.restore!.key } },
      // a version that is not there
      { ...good, restore: { ...good.restore!, version: 9 } },
      // another profile's blob under this one's name: its digest is right, its tag is not
      { ...good, profileId: other.profileId },
    ];
    // the swapped blob: another profile's version moved under this profile's key
    const moved = await r.profileStore!.get(
      profileBlobKey(idToUuid(projectId), idToUuid(other.profileId), 3),
      other.restore!.bytes,
    );
    const target = newId("prf");
    await r.profileStore!.put(
      profileBlobKey(idToUuid(projectId), idToUuid(target), 3),
      moved,
    );
    cases.push({ profileId: target as never, restore: other.restore! });

    const runs = r.docker.runCalls;
    const pool = r.store.allPool().length;
    for (const [i, profile] of cases.entries()) {
      const res = await r.agent.start(startReq({ projectId, profile }));
      expect(res, `case ${i}`).toMatchObject({
        result: "failed",
        code: "profile_unavailable",
      });
    }
    expect(r.docker.runCalls).toBe(runs);
    expect(r.store.allPool()).toHaveLength(pool);
    expect(r.store.allBindings()).toEqual([]);
  });

  it("refuses a browser whose Chrome is not the node's own, and tries the next", async () => {
    const r = await rig({ warmPool: 2, startRetries: 1 });
    await r.agent.refillPool();
    await r.agent.idle();
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    r.runtime.chromeVersion = "Chrome/150.0.0.1";
    const res = await r.agent.start(startReq({ projectId, profile }));
    expect(res).toMatchObject({ result: "failed" });
    expect(String((res as { reason: string }).reason)).toContain("Chrome/150");
    // each browser it went into is gone
    expect(r.store.allBindings()).toEqual([]);
    r.runtime.chromeVersion = "Chrome/154.0.8037.92";
    await r.agent.refillPool();
    await r.agent.idle();
    expect(await r.agent.start(startReq({ projectId, profile }))).toMatchObject(
      { result: "ready", startPath: "warm" },
    );
  });

  it("is refused (for another node) without a profile store or a Chrome, or for a newer Chrome's profile", async () => {
    const r = await rig();
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const newer = {
      ...profile,
      restore: { ...profile.restore!, chromeMajor: 155 },
    };
    expect(
      await r.agent.start(startReq({ projectId, profile: newer })),
    ).toMatchObject({ result: "refused" });
    const bare = makeRig();
    await bare.agent.boot();
    expect(
      await bare.agent.start(startReq({ projectId, profile })),
    ).toMatchObject({ result: "refused" });
  });

  it("ends profile_unavailable at once when no warm clone can take it (microVM: no warm template, or its clock is off)", async () => {
    const r = await rig({ warmPool: 0, startRetries: 2 });
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const run = r.docker.run.bind(r.docker);
    let warmRuns = 0;
    r.docker.run = async (spec) => {
      if (spec.Labels?.["kestrel.level"] === "warm") {
        warmRuns++;
        throw new WarmCloneError(
          "the warm clone's clock is 3000 ms off the host's",
        );
      }
      return run(spec);
    };
    const res = await r.agent.start(startReq({ projectId, profile }));
    expect(res).toMatchObject({
      result: "failed",
      code: "profile_unavailable",
    });
    expect(warmRuns).toBe(1); // no other clone is tried: each would be the same
    expect(r.store.allBindings()).toEqual([]);
  });

  it("holds at most four archives at once: a burst of restores waits its turn", async () => {
    const r = await rig({ slotsTotal: 8, warmPool: 0, poolTarget: 0 });
    const projectId = prj();
    const profile = await savedVersion(r.profileStore!, projectId);
    const store = r.profileStore!;
    const get = store.get.bind(store);
    let reading = 0;
    let release!: () => void;
    const gate = new Promise<void>((x) => (release = x));
    store.get = async (k, n) => {
      reading++;
      await gate;
      return get(k, n);
    };
    const starts = Array.from({ length: 6 }, () =>
      r.agent.start(startReq({ projectId, profile })),
    );
    await new Promise((x) => setTimeout(x, 100));
    expect(reading).toBe(4);
    release();
    const res = await Promise.all(starts);
    expect(res.every((x) => x.result === "ready")).toBe(true);
    expect(reading).toBe(6);
  });

  it("starts an empty profile (nothing saved yet) on the hot path", async () => {
    const r = await rig();
    const res = await r.agent.start(
      startReq({ profile: { profileId: newId("prf") } }),
    );
    expect(res).toMatchObject({ result: "ready", startPath: "hot" });
    expect(r.runtime.profiles.size).toBe(0);
  });

  it("refuses a profile archive that does not parse, even one the agent itself sealed", async () => {
    const r = await rig();
    const projectId = prj();
    const profile = await savedVersion(
      r.profileStore!,
      projectId,
      3,
      Buffer.concat([ARCHIVE, randomBytes(3)]),
    );
    expect(await r.agent.start(startReq({ projectId, profile }))).toMatchObject(
      { result: "failed", code: "profile_unavailable" },
    );
  });
});
