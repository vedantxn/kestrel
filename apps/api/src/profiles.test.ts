import { randomBytes } from "node:crypto";
import {
  ErrorResponse,
  ListProfilesResponse,
  Profile,
  idToUuid,
  newId,
} from "@kestrel/contracts";
import { profileBlobKey } from "@kestrel/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadProfiles, parseMasterKey } from "./config.js";
import { newUuid } from "./ids.js";
import { makeEnv, type Env, type EnvOptions } from "./test/harness.js";

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});
afterAll(async () => env?.close());

async function setup(opts: EnvOptions = { profiles: true }): Promise<Env> {
  env = await makeEnv(opts);
  return env;
}

const send = (
  e: Env,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
  key = e.key,
) =>
  e.api.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const error = (res: { json(): unknown }) =>
  ErrorResponse.parse(res.json()).error;

describe("/v1/profiles", () => {
  it("creates, gets, lists and deletes", async () => {
    const e = await setup();
    const res = await send(e, "POST", "/v1/profiles", {
      name: "work",
      metadata: { team: "a" },
    });
    expect(res.statusCode).toBe(201);
    const p = Profile.parse(res.json());
    expect(p).toMatchObject({
      name: "work",
      metadata: { team: "a" },
      version: 0,
      bytes: 0,
      savedAt: null,
      savedBySessionId: null,
      chromeMajor: null,
      inUseBy: null,
    });
    const unnamed = Profile.parse(
      (await send(e, "POST", "/v1/profiles", {})).json(),
    );
    expect(unnamed.name).toBeNull();

    expect(
      Profile.parse((await send(e, "GET", `/v1/profiles/${p.id}`)).json()),
    ).toEqual(p);
    const list = ListProfilesResponse.parse(
      (await send(e, "GET", "/v1/profiles")).json(),
    );
    expect(list.data.map((x) => x.id).sort()).toEqual(
      [p.id, unnamed.id].sort(),
    );

    const del = await send(e, "DELETE", `/v1/profiles/${p.id}`);
    expect(del.statusCode).toBe(204);
    expect((await send(e, "GET", `/v1/profiles/${p.id}`)).statusCode).toBe(404);
    // a second delete is not_found
    expect((await send(e, "DELETE", `/v1/profiles/${p.id}`)).statusCode).toBe(
      404,
    );
    expect(
      ListProfilesResponse.parse((await send(e, "GET", "/v1/profiles")).json())
        .data,
    ).toHaveLength(1);
  });

  it("pages newest first", async () => {
    const e = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        Profile.parse((await send(e, "POST", "/v1/profiles", {})).json()).id,
      );
      e.clock.advance(1);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ListProfilesResponse = ListProfilesResponse.parse(
        (
          await send(
            e,
            "GET",
            `/v1/profiles?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
          )
        ).json(),
      );
      seen.push(...page.data.map((x) => x.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    expect(
      (await send(e, "GET", "/v1/profiles?cursor=bm9wZQ")).statusCode,
    ).toBe(400);
  });

  it("keeps names unique among live profiles only", async () => {
    const e = await setup();
    const p = Profile.parse(
      (await send(e, "POST", "/v1/profiles", { name: "a" })).json(),
    );
    const dup = await send(e, "POST", "/v1/profiles", { name: "a" });
    expect(dup.statusCode).toBe(409);
    expect(error(dup)).toMatchObject({ param: "name", retryable: false });
    // another project may use the name
    expect(
      (await send(e, "POST", "/v1/profiles", { name: "a" }, e.project2.key))
        .statusCode,
    ).toBe(201);
    // and it is free again once deleted
    await send(e, "DELETE", `/v1/profiles/${p.id}`);
    expect(
      (await send(e, "POST", "/v1/profiles", { name: "a" })).statusCode,
    ).toBe(201);
  });

  it("validates the request strictly", async () => {
    const e = await setup();
    for (const bad of [
      { name: "" },
      { name: "x".repeat(101) },
      { name: "a\u0000b" },
      { owner: "me" },
      { metadata: { k: 1 } },
    ]) {
      const res = await send(e, "POST", "/v1/profiles", bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("answers the same not_found for a missing, deleted or other project's profile", async () => {
    const e = await setup();
    const p = Profile.parse((await send(e, "POST", "/v1/profiles", {})).json());
    const gone = Profile.parse(
      (await send(e, "POST", "/v1/profiles", {})).json(),
    );
    await send(e, "DELETE", `/v1/profiles/${gone.id}`);
    const answers = await Promise.all(
      [
        `/v1/profiles/${newId("prf")}`,
        `/v1/profiles/${gone.id}`,
        "/v1/profiles/ses_00000000000000000000000000",
        "/v1/profiles/nonsense",
      ].map((u) => send(e, "GET", u)),
    );
    answers.push(
      await send(e, "GET", `/v1/profiles/${p.id}`, undefined, e.project2.key),
    );
    answers.push(
      await send(
        e,
        "DELETE",
        `/v1/profiles/${p.id}`,
        undefined,
        e.project2.key,
      ),
    );
    for (const a of answers) {
      expect(a.statusCode).toBe(404);
      expect(error(a).message).toBe("No such profile.");
    }
    // the other project's delete changed nothing
    expect((await send(e, "GET", `/v1/profiles/${p.id}`)).statusCode).toBe(200);
    expect(
      ListProfilesResponse.parse(
        (
          await send(e, "GET", "/v1/profiles", undefined, e.project2.key)
        ).json(),
      ).data,
    ).toEqual([]);
  });

  it("refuses more than the project's profiles, counting only live ones", async () => {
    const e = await setup();
    await e.db.project.update({
      where: { id: e.projectId },
      data: { maxProfiles: 2 },
    });
    const a = Profile.parse((await send(e, "POST", "/v1/profiles", {})).json());
    await send(e, "POST", "/v1/profiles", {});
    const third = await send(e, "POST", "/v1/profiles", {});
    expect(third.statusCode).toBe(429);
    expect(error(third)).toMatchObject({
      code: "quota_exceeded",
      retryable: false,
    });
    expect(error(third).message).toContain("2 profiles");
    // concurrent creates at the limit never pass it
    await send(e, "DELETE", `/v1/profiles/${a.id}`);
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => send(e, "POST", "/v1/profiles", {})),
    );
    expect(burst.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(
      await e.db.profile.count({
        where: { projectId: e.projectId, deletedAt: null },
      }),
    ).toBe(2);
  });

  it("deletes the blobs, the version rows and the lock with the profile", async () => {
    const e = await setup();
    const p = Profile.parse((await send(e, "POST", "/v1/profiles", {})).json());
    const uuid = idToUuid(p.id);
    const writer = newUuid();
    await e.db.profile.update({
      where: { id: uuid },
      data: {
        writerSessionId: writer,
        writerSince: new Date(),
        currentVersion: 1,
      },
    });
    const now = new Date(e.clock.now());
    await e.db.profileVersion.createMany({
      data: [
        {
          profileId: uuid,
          version: 1,
          state: "committed",
          sessionId: newUuid(),
          wrappedKey: randomBytes(60),
          bytes: 3n,
          createdAt: now,
        },
        {
          profileId: uuid,
          version: 2,
          state: "pending",
          sessionId: writer,
          wrappedKey: randomBytes(60),
          createdAt: now,
        },
      ],
    });
    const store = e.ctx.profiles!.store;
    await store.put(profileBlobKey(e.projectId, uuid, 1), Buffer.from("one"));
    await store.put(profileBlobKey(e.projectId, uuid, 2), Buffer.from("two"));
    const got = Profile.parse(
      (await send(e, "GET", `/v1/profiles/${p.id}`)).json(),
    );
    expect(got).toMatchObject({ version: 1, bytes: 3 });
    expect(got.inUseBy).not.toBeNull();

    expect((await send(e, "DELETE", `/v1/profiles/${p.id}`)).statusCode).toBe(
      204,
    );
    expect(await store.list("")).toEqual([]);
    expect(
      await e.db.profileVersion.count({ where: { profileId: uuid } }),
    ).toBe(0);
    const row = await e.db.profile.findUniqueOrThrow({ where: { id: uuid } });
    expect(row.writerSessionId).toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });

  it("is refused on a deployment without profiles", async () => {
    const e = await setup({});
    for (const [method, url] of [
      ["POST", "/v1/profiles"],
      ["GET", "/v1/profiles"],
      ["GET", `/v1/profiles/${newId("prf")}`],
      ["DELETE", `/v1/profiles/${newId("prf")}`],
    ] as const) {
      const res = await send(
        e,
        method,
        url,
        method === "POST" ? {} : undefined,
      );
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(error(res).message).toContain("not configured");
    }
  });

  it("needs a key", async () => {
    const e = await setup();
    const res = await e.api.inject({ method: "GET", url: "/v1/profiles" });
    expect(res.statusCode).toBe(401);
  });
});

describe("configuration", () => {
  it("reads a 32-byte master key as bytes, hex or base64, and nothing else", () => {
    const k = randomBytes(32);
    expect(parseMasterKey(k).equals(k)).toBe(true);
    expect(
      parseMasterKey(Buffer.from(`${k.toString("hex")}\n`)).equals(k),
    ).toBe(true);
    expect(parseMasterKey(Buffer.from(k.toString("base64"))).equals(k)).toBe(
      true,
    );
    expect(() => parseMasterKey(randomBytes(16))).toThrow("32-byte");
    expect(() => parseMasterKey(Buffer.from("short"))).toThrow("32-byte");
  });

  it("is off without both settings, and refuses half of them", () => {
    const max = 64 * 1024 * 1024;
    expect(
      loadProfiles({
        PROFILE_STORE_DIR: undefined,
        PROFILE_MASTER_KEY_FILE: undefined,
        PROFILE_MAX_BYTES: max,
      }),
    ).toBeUndefined();
    expect(() =>
      loadProfiles({
        PROFILE_STORE_DIR: "/tmp",
        PROFILE_MASTER_KEY_FILE: undefined,
        PROFILE_MAX_BYTES: max,
      }),
    ).toThrow("both");
    const key = randomBytes(32);
    const cfg = loadProfiles(
      {
        PROFILE_STORE_DIR: "/tmp",
        PROFILE_MASTER_KEY_FILE: "/key",
        PROFILE_MAX_BYTES: max,
      },
      () => key,
    );
    expect(cfg?.master.equals(key)).toBe(true);
    expect(cfg?.maxBytes).toBe(max);
  });
});
