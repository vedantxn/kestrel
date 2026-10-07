import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chown,
  lstat,
  mkdir,
  link,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * P18 (docs/lld/p18-profiles.md section 4.5). Where profile versions are kept: one encrypted blob
 * per version, at HLD 9's key `{project}/profiles/{profile}/{version}.kpf`. The first store is a
 * directory on the host's data volume, shared by the API and the node agents; an S3 store with
 * the same interface comes with the infrastructure plan.
 *
 * Keys are built only from ids the caller has already checked (`profileBlobKey`), never from
 * anything a browser said, and every key is checked again here.
 */
export interface ProfileStore {
  /**
   * Write a version atomically: a reader sees all of it or nothing. A version is never replaced:
   * if the key exists, the put is refused (`exists`) and what is there stays.
   */
  put(key: string, data: Uint8Array): Promise<void>;
  /** Read a version, which must be a regular file of exactly `bytes`. */
  get(key: string, bytes: number): Promise<Buffer>;
  /** Remove a version. Missing is not an error. */
  delete(key: string): Promise<void>;
  /** The versions under a prefix (`""`, `{project}/` or `{project}/profiles/{profile}/`). */
  list(prefix: string): Promise<ProfileStoreEntry[]>;
  /** Remove temporary files left by a crash, older than `olderThanMs`. Returns how many. */
  sweep(olderThanMs: number, now?: number): Promise<number>;
}

export interface ProfileStoreEntry {
  key: string;
  bytes: number;
  mtimeMs: number;
}

export type ProfileStoreErrorCode =
  | "storage_full"
  | "storage_error"
  | "missing"
  | "invalid"
  /** The version is already there: a version is never replaced. */
  | "exists";

export class ProfileStoreError extends Error {
  constructor(
    readonly code: ProfileStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProfileStoreError";
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(
  `^(${UUID})/profiles/(${UUID})/([1-9][0-9]{0,9})\\.kpf$`,
);
const PREFIX_RE = new RegExp(`^(|${UUID}/|${UUID}/profiles/${UUID}/)$`);
const TMP_RE = /^\.[0-9a-f]{16}\.tmp$/;
const VERSION_FILE_RE = /^[1-9][0-9]{0,9}\.kpf$/;
const UUID_RE = new RegExp(`^${UUID}$`);

export function profileBlobKey(
  projectUuid: string,
  profileUuid: string,
  version: number,
): string {
  const key = `${projectUuid}/profiles/${profileUuid}/${version}.kpf`;
  if (!KEY_RE.test(key)) throw new ProfileStoreError("invalid", "bad key");
  return key;
}

export function profilePrefix(
  projectUuid: string,
  profileUuid?: string,
): string {
  const p =
    profileUuid === undefined
      ? `${projectUuid}/`
      : `${projectUuid}/profiles/${profileUuid}/`;
  if (!PREFIX_RE.test(p)) throw new ProfileStoreError("invalid", "bad prefix");
  return p;
}

function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function storeError(e: unknown, what: string): ProfileStoreError {
  if (e instanceof ProfileStoreError) return e;
  const code = errnoOf(e);
  return new ProfileStoreError(
    code === "ENOSPC" || code === "EDQUOT" ? "storage_full" : "storage_error",
    `${what}: ${code ?? (e instanceof Error ? e.message : "failed")}`,
  );
}

/**
 * The store as a directory. Directories are made one segment at a time and each is required to be
 * a real directory (not a link) whose resolved path stays under the root; files are opened with
 * `O_NOFOLLOW`. `owner` (the API's uid, on the host) is given every directory and file made, so
 * the API, which deletes, and the agents, which run as root and write, share one tree.
 */
export class FsProfileStore implements ProfileStore {
  private realRoot: string | undefined;

  constructor(
    private readonly root: string,
    private readonly owner?: { uid: number; gid: number },
  ) {}

  private async rootPath(): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    return this.realRoot;
  }

  /** The directory for a key's segments, checked (and made, if `make`). */
  private async dir(segments: string[], make: boolean): Promise<string> {
    const root = await this.rootPath();
    let path = root;
    for (const s of segments) {
      path = join(path, s);
      if (make) {
        try {
          await mkdir(path, { mode: 0o700 });
          if (this.owner) await chown(path, this.owner.uid, this.owner.gid);
        } catch (e) {
          if (errnoOf(e) !== "EEXIST") throw e;
        }
      }
      const st = await lstat(path);
      if (!st.isDirectory())
        throw new ProfileStoreError("invalid", "not a directory on the way");
      const real = await realpath(path);
      if (real !== path || !real.startsWith(root + sep))
        throw new ProfileStoreError("invalid", "outside the store");
    }
    return path;
  }

  private parse(key: string): { dirs: string[]; file: string } {
    if (!KEY_RE.test(key)) throw new ProfileStoreError("invalid", "bad key");
    const parts = key.split("/");
    return { dirs: parts.slice(0, 3), file: parts[3]! };
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const { dirs, file } = this.parse(key);
    try {
      const dir = await this.dir(dirs, true);
      const final = join(dir, file);
      // A version, once written, is never replaced: not by a late writer, not through a link.
      try {
        const st = await lstat(final);
        throw st.isFile()
          ? new ProfileStoreError("exists", "the version is already written")
          : new ProfileStoreError("invalid", "not a regular file");
      } catch (e) {
        if (errnoOf(e) !== "ENOENT") throw e;
      }
      const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
      const fh = await open(
        tmp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          await fh.writeFile(data);
          await fh.datasync();
          if (this.owner) await fh.chown(this.owner.uid, this.owner.gid);
        } finally {
          await fh.close();
        }
        // link(2) fails if anything is at the final name, so two writers racing to one key
        // cannot replace each other: the second is refused.
        await link(tmp, final).catch((e: unknown) => {
          if (errnoOf(e) === "EEXIST")
            throw new ProfileStoreError(
              "exists",
              "the version is already written",
            );
          throw e;
        });
        await unlink(tmp);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await syncDir(dir);
    } catch (e) {
      throw storeError(e, "put");
    }
  }

  async get(key: string, bytes: number): Promise<Buffer> {
    const { dirs, file } = this.parse(key);
    let dir: string;
    try {
      dir = await this.dir(dirs, false);
    } catch (e) {
      if (errnoOf(e) === "ENOENT")
        throw new ProfileStoreError("missing", "no such version");
      throw storeError(e, "get");
    }
    let fh;
    try {
      fh = await open(
        join(dir, file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (e) {
      if (errnoOf(e) === "ENOENT")
        throw new ProfileStoreError("missing", "no such version");
      if (errnoOf(e) === "ELOOP")
        throw new ProfileStoreError("invalid", "a link at the version");
      throw storeError(e, "get");
    }
    try {
      const st = await fh.stat();
      if (!st.isFile())
        throw new ProfileStoreError("invalid", "not a regular file");
      if (st.size !== bytes)
        throw new ProfileStoreError("invalid", "wrong length");
      const out = Buffer.alloc(bytes);
      let off = 0;
      while (off < bytes) {
        const { bytesRead } = await fh.read(out, off, bytes - off, off);
        if (bytesRead === 0)
          throw new ProfileStoreError("invalid", "shorter than its length");
        off += bytesRead;
      }
      return out;
    } catch (e) {
      throw storeError(e, "get");
    } finally {
      await fh.close();
    }
  }

  async delete(key: string): Promise<void> {
    const { dirs, file } = this.parse(key);
    let dir: string;
    try {
      dir = await this.dir(dirs, false);
    } catch (e) {
      if (errnoOf(e) === "ENOENT") return;
      throw storeError(e, "delete");
    }
    try {
      await unlink(join(dir, file));
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") throw storeError(e, "delete");
    }
    // The profile's directory goes with its last version; anything else in it keeps it.
    await rmdir(dir).catch(() => {});
  }

  async list(prefix: string): Promise<ProfileStoreEntry[]> {
    if (!PREFIX_RE.test(prefix))
      throw new ProfileStoreError("invalid", "bad prefix");
    const want = prefix.split("/").filter(Boolean);
    const out: ProfileStoreEntry[] = [];
    await this.walk(async (key, path) => {
      if (!key.startsWith(prefix) || !KEY_RE.test(key)) return;
      const st = await lstat(path);
      if (st.isFile()) out.push({ key, bytes: st.size, mtimeMs: st.mtimeMs });
    }, want);
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async sweep(olderThanMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    await this.walk(async (_key, path, name) => {
      if (!TMP_RE.test(name)) return;
      const st = await lstat(path);
      if (now - st.mtimeMs < olderThanMs) return;
      await unlink(path).catch(() => {});
      removed++;
    }, []);
    return removed;
  }

  /**
   * Visit every file in the tree's expected shape (`{project}/profiles/{profile}/{file}`), never
   * following a link. `only` narrows the walk to a prefix's segments.
   */
  private async walk(
    visit: (key: string, path: string, name: string) => Promise<void>,
    only: string[],
  ): Promise<void> {
    const root = await this.rootPath();
    const entries = async (dir: string) => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    for (const p of await entries(root)) {
      if (!p.isDirectory() || !UUID_RE.test(p.name)) continue;
      if (only[0] !== undefined && p.name !== only[0]) continue;
      const profilesDir = join(root, p.name, "profiles");
      const st = await lstat(profilesDir).catch(() => null);
      if (!st?.isDirectory()) continue;
      for (const f of await entries(profilesDir)) {
        if (!f.isDirectory() || !UUID_RE.test(f.name)) continue;
        if (only[2] !== undefined && f.name !== only[2]) continue;
        const dir = join(profilesDir, f.name);
        for (const v of await entries(dir)) {
          if (!v.isFile()) continue;
          if (!VERSION_FILE_RE.test(v.name) && !TMP_RE.test(v.name)) continue;
          await visit(
            `${p.name}/profiles/${f.name}/${v.name}`,
            join(dir, v.name),
            v.name,
          );
        }
      }
    }
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, constants.O_RDONLY);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Some filesystems refuse fsync on a directory; the rename is still atomic.
  }
}
