import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FsProfileStore,
  ProfileStoreError,
  profileBlobKey,
  profilePrefix,
} from "./profile-store.js";

let root: string;
let store: FsProfileStore;
const project = randomUUID();
const profile = randomUUID();
const key = (v: number, p = profile, j = project) => profileBlobKey(j, p, v);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kpf-"));
  store = new FsProfileStore(root);
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof ProfileStoreError) return e.code;
    throw e;
  }
}

describe("keys", () => {
  it("are built only from uuids and a positive version", () => {
    expect(key(1)).toBe(`${project}/profiles/${profile}/1.kpf`);
    expect(() => profileBlobKey("../x", profile, 1)).toThrow(ProfileStoreError);
    expect(() => profileBlobKey(project, profile, 0)).toThrow(
      ProfileStoreError,
    );
    expect(() => profileBlobKey(project, `${profile}/..`, 1)).toThrow(
      ProfileStoreError,
    );
    expect(profilePrefix(project)).toBe(`${project}/`);
    expect(() => profilePrefix("..")).toThrow(ProfileStoreError);
  });
});

describe("FsProfileStore", () => {
  it("puts, gets, lists and deletes", async () => {
    await store.put(key(1), Buffer.from("one"));
    await store.put(key(2), Buffer.from("two!"));
    expect((await store.get(key(1), 3)).toString()).toBe("one");
    expect(
      (await store.list(profilePrefix(project, profile))).map((e) => [
        e.key,
        e.bytes,
      ]),
    ).toEqual([
      [key(1), 3],
      [key(2), 4],
    ]);
    expect(await store.list("")).toHaveLength(2);
    expect(await store.list(profilePrefix(randomUUID()))).toEqual([]);
    await store.delete(key(1));
    await store.delete(key(1)); // missing is fine
    expect(await code(store.get(key(1), 3))).toBe("missing");
    await store.delete(key(2));
    // the profile's directory goes with its last version
    expect(readdirSync(join(root, project, "profiles"))).toEqual([]);
  });

  it("refuses a bad key", async () => {
    expect(await code(store.put("../../etc/passwd", Buffer.from("x")))).toBe(
      "invalid",
    );
    expect(await code(store.get(`${project}/profiles/x/1.kpf`, 1))).toBe(
      "invalid",
    );
  });

  it("checks the length on get", async () => {
    await store.put(key(1), Buffer.from("abc"));
    expect(await code(store.get(key(1), 4))).toBe("invalid");
    expect(await code(store.get(key(1), 2))).toBe("invalid");
    expect(await code(store.get(key(9), 2))).toBe("missing");
  });

  it("writes atomically: only a temporary file is left before the rename", async () => {
    await store.put(key(1), Buffer.from("old"));
    const dir = join(root, project, "profiles", profile);
    // a crash between write and link leaves a temporary file and the old version
    writeFileSync(join(dir, ".0123456789abcdef.tmp"), "half");
    expect((await store.get(key(1), 3)).toString()).toBe("old");
    expect((await store.list("")).map((e) => e.key)).toEqual([key(1)]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([
      ".0123456789abcdef.tmp",
    ]);
  });

  it("never replaces a version: a second put of the key is refused and the first stays", async () => {
    await store.put(key(1), Buffer.from("committed"));
    expect(await code(store.put(key(1), Buffer.from("late writer")))).toBe(
      "exists",
    );
    expect((await store.get(key(1), 9)).toString()).toBe("committed");
    // two writers racing to one key: exactly one wins, and no temporary file is left
    const both = await Promise.all([
      code(store.put(key(2), Buffer.from("aaaa"))),
      code(store.put(key(2), Buffer.from("bbbb"))),
    ]);
    expect(both.sort()).toEqual(["exists", "ok"]);
    const dir = join(root, project, "profiles", profile);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("sweeps old temporary files and keeps young ones and versions", async () => {
    await store.put(key(1), Buffer.from("v"));
    const dir = join(root, project, "profiles", profile);
    writeFileSync(join(dir, ".0123456789abcdef.tmp"), "old");
    writeFileSync(join(dir, ".fedcba9876543210.tmp"), "young");
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    utimesSync(join(dir, ".0123456789abcdef.tmp"), hourAgo, hourAgo);
    expect(await store.sweep(600_000)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([".fedcba9876543210.tmp", "1.kpf"]);
  });

  it("refuses a planted symlink at the version path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kpf-out-"));
    writeFileSync(join(outside, "secret"), "abc");
    const dir = join(root, project, "profiles", profile);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, "secret"), join(dir, "1.kpf"));
    expect(await code(store.get(key(1), 3))).toBe("invalid");
    expect(await code(store.put(key(1), Buffer.from("xyz")))).toBe("invalid");
    expect(await store.list("")).toEqual([]);
  });

  it("refuses a planted symlink at a directory on the way", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kpf-out-"));
    mkdirSync(join(outside, "profiles", profile), { recursive: true });
    writeFileSync(join(outside, "profiles", profile, "1.kpf"), "abc");
    symlinkSync(outside, join(root, project));
    expect(await code(store.get(key(1), 3))).toBe("invalid");
    expect(await code(store.put(key(2), Buffer.from("x")))).toBe("invalid");
    expect(readdirSync(join(outside, "profiles", profile))).toEqual(["1.kpf"]);
    expect(await store.list("")).toEqual([]);
    // a link deeper down too
    const other = randomUUID();
    mkdirSync(join(root, other));
    symlinkSync(join(outside, "profiles"), join(root, other, "profiles"));
    expect(await code(store.get(key(1, profile, other), 3))).toBe("invalid");
  });
});
