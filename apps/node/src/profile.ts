import { createHash } from "node:crypto";
import {
  PROFILE_LIMITS,
  ProfileArchiveError,
  ProfileArchiveParser,
  idToUuid,
  maxProfileArchiveBytes,
  type EndReason,
  type ProfileSaveFailure,
  type StartProfile,
} from "@kestrel/contracts";
import {
  ProfileStoreError,
  openProfileBlob,
  profileBlobKey,
  profilePrefix,
  sealProfileBlob,
  type ProfileBlobIds,
  type ProfileStore,
} from "@kestrel/shared";
import type { ProfileSave } from "./store.js";

/**
 * P18 (docs/lld/p18-profiles.md sections 4.1, 4.4, 4.5 and 4.7): the node agent's half of a
 * profile. Restore reads the version's blob from the store at a path built from the start
 * request's ids, checks its length and digest, decrypts and decompresses it under a cap, and parses
 * the archive before any of it goes to a browser. Save takes what a browser answers as hostile:
 * every rule of the archive is checked before a byte is sealed, and nothing in it ever becomes a
 * host path; the one file written is named from ids the agent already has.
 */

/** The ends after which a writer's browser is healthy and its state is saved (open question 1). */
export const CLEAN_ENDS: readonly EndReason[] = [
  "client_stop",
  "client_disconnect",
  "idle_timeout",
  "max_lifetime",
];

/** The profile cannot be restored: no other browser would do better (`profile_unavailable`). */
export class ProfileUnavailable extends Error {}

/** A save that did not happen, and why (`profile.save_failed`). */
export class SaveFailed extends Error {
  constructor(
    readonly reason: ProfileSaveFailure,
    message: string = reason,
  ) {
    super(message);
  }
}

export function blobIds(
  projectId: string,
  profileId: string,
  version: number,
): ProfileBlobIds {
  return {
    projectUuid: idToUuid(projectId),
    profileUuid: idToUuid(profileId),
    version,
  };
}

const sha256 = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/**
 * Check every archive rule without copying a file's bytes: the push parser hands back views into
 * the buffer, which are dropped. (`parseProfileArchive` collects a copy of every file.)
 */
export function validateArchive(body: Buffer, maxBytes: number): void {
  const p = new ProfileArchiveParser(maxBytes);
  p.push(body);
  p.finish();
}

/** The largest archive any version may hold, decompressed. */
const RESTORE_CAP = maxProfileArchiveBytes(PROFILE_LIMITS.maxBytesCeiling);

/**
 * The archive to restore: the blob at the path the ids name, exactly `bytes` long with the
 * expected digest, opened with the version's key (nothing is decompressed before its tag
 * verifies) and parsed. Throws `ProfileUnavailable`.
 */
export async function readRestore(
  store: ProfileStore,
  projectId: string,
  p: StartProfile,
): Promise<Buffer> {
  const r = p.restore;
  if (!r) throw new ProfileUnavailable("nothing to restore");
  const ids = blobIds(projectId, p.profileId, r.version);
  let blob: Buffer;
  try {
    blob = await store.get(
      profileBlobKey(ids.projectUuid, ids.profileUuid, r.version),
      r.bytes,
    );
  } catch (e) {
    throw new ProfileUnavailable(
      `the profile's blob: ${e instanceof ProfileStoreError ? e.code : "unreadable"}`,
    );
  }
  if (sha256(blob) !== r.sha256)
    throw new ProfileUnavailable("the profile's blob has the wrong digest");
  let archive: Buffer;
  try {
    archive = await openProfileBlob(
      Buffer.from(r.key, "base64"),
      ids,
      blob,
      RESTORE_CAP,
    );
    validateArchive(archive, PROFILE_LIMITS.maxBytesCeiling);
  } catch {
    throw new ProfileUnavailable("the profile's blob does not open");
  }
  return archive;
}

/** A browser's save answer, as hostile input: every archive rule, against the save's cap. */
export function checkSaved(body: Buffer, maxBytes: number): Buffer {
  try {
    validateArchive(body, maxBytes);
  } catch (e) {
    if (e instanceof ProfileArchiveError) throw new SaveFailed(e.reason);
    throw new SaveFailed("invalid_archive");
  }
  return body;
}

/**
 * Seal the archive with the save's key and write it as the save's version. A version is never
 * replaced (the store refuses): if it is already there, this writer wrote it before a restart,
 * so it is read back, checked to open with this writer's key, and its length and digest reported.
 */
export async function sealAndPut(
  store: ProfileStore,
  s: ProfileSave,
  archive: Uint8Array,
): Promise<{ bytes: number; sha256: string }> {
  const ids = blobIds(s.projectId, s.profileId, s.version);
  const key = Buffer.from(s.saveKey, "base64");
  const blob = await sealProfileBlob(key, ids, archive);
  try {
    await store.put(
      profileBlobKey(ids.projectUuid, ids.profileUuid, s.version),
      blob,
    );
  } catch (e) {
    if (e instanceof ProfileStoreError && e.code === "exists") {
      const back = await readBack(store, s);
      if (back) return back;
    }
    throw new SaveFailed(
      e instanceof ProfileStoreError && e.code === "storage_full"
        ? "storage_full"
        : "storage_error",
    );
  }
  return { bytes: blob.length, sha256: sha256(blob) };
}

/**
 * The save's version as the store holds it, if it is there and opens with this writer's key
 * (so it is this writer's, whole): its length and digest. Null if it is not there.
 */
export async function readBack(
  store: ProfileStore,
  s: ProfileSave,
): Promise<{ bytes: number; sha256: string } | null> {
  const ids = blobIds(s.projectId, s.profileId, s.version);
  const key = profileBlobKey(ids.projectUuid, ids.profileUuid, s.version);
  let entry;
  try {
    entry = (
      await store.list(profilePrefix(ids.projectUuid, ids.profileUuid))
    ).find((e) => e.key === key);
  } catch {
    throw new SaveFailed("storage_error");
  }
  if (!entry) return null;
  try {
    const blob = await store.get(key, entry.bytes);
    await openProfileBlob(
      Buffer.from(s.saveKey, "base64"),
      ids,
      blob,
      maxProfileArchiveBytes(s.maxBytes),
    );
    return { bytes: blob.length, sha256: sha256(blob) };
  } catch {
    throw new SaveFailed("storage_error");
  }
}
