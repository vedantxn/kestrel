import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { profileView, readProfileStoreDir } from "./collect-profiles.js";

const PROJECT = "0192aaaa-0000-7000-8000-000000000001";
const PROFILE = "0192bbbb-0000-7000-8000-000000000002";
const OTHER = "0192cccc-0000-7000-8000-000000000003";

describe("reading the profile store for the invariant checker (P18)", () => {
  it("lists versions and temporary files with their ages, and everything else apart", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-"));
    const dir = join(root, PROJECT, "profiles", PROFILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.kpf"), "x");
    writeFileSync(join(dir, "2.kpf"), "x");
    writeFileSync(join(dir, ".0123456789abcdef.tmp"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    symlinkSync(join(dir, "1.kpf"), join(dir, "3.kpf"));
    mkdirSync(join(root, "lost+found"));
    const now = Date.now();
    const hourAgo = new Date(now - 3600_000);
    utimesSync(join(dir, "1.kpf"), hourAgo, hourAgo);

    const got = await readProfileStoreDir(root, now);
    expect(got).not.toBeNull();
    const key = (v: string) => `${PROJECT}/profiles/${PROFILE}/${v}`;
    expect(got!.versions.map((v) => v.key).sort()).toEqual([
      key("1.kpf"),
      key("2.kpf"),
    ]);
    expect(
      got!.versions.find((v) => v.key === key("1.kpf"))!.ageSeconds,
    ).toBeGreaterThanOrEqual(3599);
    expect(got!.temporary.map((t) => t.path)).toEqual([
      key(".0123456789abcdef.tmp"),
    ]);
    // A link is never taken for a version, and odd names are kept apart.
    expect(got!.other.sort()).toEqual(
      [key("3.kpf"), key("notes.txt"), "lost+found"].sort(),
    );
  });

  it("says when the store is not here", async () => {
    expect(await readProfileStoreDir(join(tmpdir(), "no-such-store"))).toBe(
      null,
    );
  });

  it("matches blobs to live profiles' version rows by their key", () => {
    const view = profileView(
      {
        locks: [
          {
            profileUuid: PROFILE,
            sessionUuid: OTHER,
            status: "stopped",
            age: 40,
          },
        ],
        pending: [],
        versions: [{ projectUuid: PROJECT, profileUuid: PROFILE, version: 1 }],
      },
      {
        versions: [
          { key: `${PROJECT}/profiles/${PROFILE}/1.kpf`, ageSeconds: 9 },
          { key: `${PROJECT}/profiles/${PROFILE}/2.kpf`, ageSeconds: 9 },
          // The same profile and version under another project is not that row's blob.
          { key: `${OTHER}/profiles/${PROFILE}/1.kpf`, ageSeconds: 9 },
        ],
        temporary: [],
        other: [],
      },
    );
    expect(view.store!.blobs.map((b) => b.hasRow)).toEqual([
      true,
      false,
      false,
    ]);
    expect(view.locks[0]).toMatchObject({
      profileId: expect.stringMatching(/^prf_/),
      sessionId: expect.stringMatching(/^ses_/),
      sessionStatus: "stopped",
    });
    expect(
      profileView({ locks: [], pending: [], versions: [] }, null).store,
    ).toBeNull();
  });
});
