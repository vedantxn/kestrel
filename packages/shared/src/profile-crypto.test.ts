import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  PROFILE_BLOB_HEADER_BYTES,
  ProfileCryptoError,
  deriveProjectKey,
  newDataKey,
  openProfileBlob,
  sealProfileBlob,
  unwrapDataKey,
  wrapDataKey,
} from "./profile-crypto.js";

const master = randomBytes(32);
const project = randomUUID();
const profile = randomUUID();
const ids = { projectUuid: project, profileUuid: profile, version: 3 };
const archive = Buffer.concat([
  Buffer.from("archive "),
  randomBytes(1000),
  Buffer.alloc(5000, 7),
]);

describe("project keys", () => {
  it("are derived per project, deterministically, from the master key", () => {
    const a = deriveProjectKey(master, project);
    expect(a).toHaveLength(32);
    expect(deriveProjectKey(master, project).equals(a)).toBe(true);
    expect(deriveProjectKey(master, randomUUID()).equals(a)).toBe(false);
    expect(deriveProjectKey(randomBytes(32), project).equals(a)).toBe(false);
    expect(() => deriveProjectKey(randomBytes(16), project)).toThrow(
      ProfileCryptoError,
    );
  });
});

describe("data keys", () => {
  const kek = deriveProjectKey(master, project);

  it("wrap and unwrap for the same profile and version only", () => {
    const key = newDataKey();
    const wrapped = wrapDataKey(kek, key, profile, 3);
    expect(wrapped).toHaveLength(60);
    expect(wrapped.includes(key)).toBe(false);
    expect(unwrapDataKey(kek, wrapped, profile, 3).equals(key)).toBe(true);
    expect(() => unwrapDataKey(kek, wrapped, profile, 4)).toThrow(
      ProfileCryptoError,
    );
    expect(() => unwrapDataKey(kek, wrapped, randomUUID(), 3)).toThrow(
      ProfileCryptoError,
    );
    // another project's key opens nothing of this one's
    const other = deriveProjectKey(master, randomUUID());
    expect(() => unwrapDataKey(other, wrapped, profile, 3)).toThrow(
      ProfileCryptoError,
    );
    const flipped = Buffer.from(wrapped);
    flipped[20]! ^= 1;
    expect(() => unwrapDataKey(kek, flipped, profile, 3)).toThrow(
      ProfileCryptoError,
    );
    expect(() =>
      unwrapDataKey(kek, wrapped.subarray(0, 59), profile, 3),
    ).toThrow(ProfileCryptoError);
  });
});

describe("blobs", () => {
  const key = newDataKey();

  it("round-trip, and hold no plaintext", async () => {
    const blob = await sealProfileBlob(key, ids, archive);
    expect(blob.subarray(0, 4).toString()).toBe("KPF1");
    expect(blob.includes(Buffer.from("archive "))).toBe(false);
    expect(
      (await openProfileBlob(key, ids, blob, archive.length)).equals(archive),
    ).toBe(true);
  });

  it("fail when moved to another project, profile or version, or opened with another key", async () => {
    const blob = await sealProfileBlob(key, ids, archive);
    for (const other of [
      { ...ids, projectUuid: randomUUID() },
      { ...ids, profileUuid: randomUUID() },
      { ...ids, version: 4 },
    ])
      await expect(openProfileBlob(key, other, blob, 1e9)).rejects.toThrow(
        ProfileCryptoError,
      );
    await expect(openProfileBlob(newDataKey(), ids, blob, 1e9)).rejects.toThrow(
      "does not decrypt",
    );
  });

  it("fail on a flipped byte anywhere, a cut tag, or a forged header", async () => {
    const blob = await sealProfileBlob(key, ids, archive);
    for (const at of [
      0,
      5,
      30,
      52,
      63,
      PROFILE_BLOB_HEADER_BYTES + 3,
      blob.length - 1,
    ]) {
      const b = Buffer.from(blob);
      b[at]! ^= 0x80;
      await expect(
        openProfileBlob(key, ids, b, 1e9),
        `byte ${at}`,
      ).rejects.toThrow(ProfileCryptoError);
    }
    await expect(
      openProfileBlob(key, ids, blob.subarray(0, blob.length - 1), 1e9),
    ).rejects.toThrow(ProfileCryptoError);
    await expect(
      openProfileBlob(key, ids, blob.subarray(0, 70), 1e9),
    ).rejects.toThrow(ProfileCryptoError);
  });

  it("stops decompressing past the cap, after the tag has verified", async () => {
    const bomb = Buffer.alloc(10 * 1024 * 1024);
    const blob = await sealProfileBlob(key, ids, bomb);
    expect(blob.length).toBeLessThan(100_000);
    await expect(openProfileBlob(key, ids, blob, 1024 * 1024)).rejects.toThrow(
      "cap",
    );
    expect((await openProfileBlob(key, ids, blob, bomb.length)).length).toBe(
      bomb.length,
    );
  });

  it("never decompresses what the tag did not cover", async () => {
    // A blob whose ciphertext was replaced with a gzip bomb fails at the tag, before gunzip.
    const blob = await sealProfileBlob(key, ids, archive);
    const forged = Buffer.concat([
      blob.subarray(0, PROFILE_BLOB_HEADER_BYTES),
      gzipSync(Buffer.alloc(1024 * 1024)),
      blob.subarray(blob.length - 16),
    ]);
    await expect(openProfileBlob(key, ids, forged, 1e9)).rejects.toThrow(
      "does not decrypt",
    );
  });
});
