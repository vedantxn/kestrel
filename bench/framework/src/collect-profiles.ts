import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { uuidToId } from "@kestrel/contracts";
import type { ProfileView } from "./invariants.js";

/**
 * P18 (docs/lld/p18-profiles.md section 10, check 12): what the invariant checker reads of
 * profiles. The database's locks and pending versions, and the profile store's files, read
 * directly from the host's store directory (mounted read-only by `infra/host/bench.sh`), never
 * through the store's own code, so a file the store would refuse to list is still seen.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_FILE = /^[1-9][0-9]{0,9}\.kpf$/;
const TEMP_FILE = /^\.[0-9a-f]{16}\.tmp$/;

export interface StoreListing {
  /** `{project}/profiles/{profile}/{version}.kpf`, as the store keys them. */
  versions: { key: string; ageSeconds: number }[];
  temporary: { path: string; ageSeconds: number }[];
  /** Anything else in the tree: the store never makes it. */
  other: string[];
}

/** Walk the store's `{project}/profiles/{profile}/` tree without following a link. Null if it is not here. */
export async function readProfileStoreDir(
  dir: string,
  nowMs = Date.now(),
): Promise<StoreListing | null> {
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const out: StoreListing = { versions: [], temporary: [], other: [] };
  const list = async (p: string) =>
    readdir(p, { withFileTypes: true }).catch(() => []);
  const age = async (p: string) =>
    Math.max(0, (nowMs - (await lstat(p)).mtimeMs) / 1000);
  for (const project of await list(dir)) {
    if (!project.isDirectory() || !UUID.test(project.name)) {
      out.other.push(project.name);
      continue;
    }
    const profilesDir = join(dir, project.name, "profiles");
    for (const profile of await list(profilesDir)) {
      const rel = `${project.name}/profiles/${profile.name}`;
      if (!profile.isDirectory() || !UUID.test(profile.name)) {
        out.other.push(rel);
        continue;
      }
      for (const f of await list(join(profilesDir, profile.name))) {
        const path = join(profilesDir, profile.name, f.name);
        if (f.isFile() && VERSION_FILE.test(f.name))
          out.versions.push({
            key: `${rel}/${f.name}`,
            ageSeconds: await age(path),
          });
        else if (f.isFile() && TEMP_FILE.test(f.name))
          out.temporary.push({
            path: `${rel}/${f.name}`,
            ageSeconds: await age(path),
          });
        else out.other.push(`${rel}/${f.name}`);
      }
    }
  }
  return out;
}

/** The rows the checker reads from the API's database (uuids as stored). */
export interface ProfileRows {
  locks: {
    profileUuid: string;
    sessionUuid: string;
    status: string | null;
    age: number | null;
  }[];
  pending: {
    profileUuid: string;
    version: number;
    sessionUuid: string;
    status: string | null;
    age: number | null;
  }[];
  /** Version rows of live (not deleted) profiles, by their store key's parts. */
  versions: { projectUuid: string; profileUuid: string; version: number }[];
}

export function profileView(
  rows: ProfileRows,
  store: StoreListing | null,
): ProfileView {
  const known = new Set(
    rows.versions.map(
      (v) => `${v.projectUuid}/profiles/${v.profileUuid}/${v.version}.kpf`,
    ),
  );
  return {
    locks: rows.locks.map((l) => ({
      profileId: uuidToId("prf", l.profileUuid),
      sessionId: uuidToId("ses", l.sessionUuid),
      sessionStatus: l.status,
      ageSeconds: l.age,
    })),
    pending: rows.pending.map((p) => ({
      profileId: uuidToId("prf", p.profileUuid),
      version: p.version,
      sessionId: uuidToId("ses", p.sessionUuid),
      sessionStatus: p.status,
      ageSeconds: p.age,
    })),
    store: store && {
      blobs: store.versions.map((b) => ({
        key: b.key,
        ageSeconds: b.ageSeconds,
        hasRow: known.has(b.key),
      })),
      temporary: store.temporary,
    },
  };
}
