import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_LIMITS,
  ProfileArchiveError,
  ProfileArchiveParser,
  ProfileCookie,
  encodeProfileArchive,
  profilePathProblem,
  type ProfileCookies,
} from "@kestrel/contracts";
import { Cdp, getVersion } from "./cdp.js";
import type { Supervisor } from "./supervisor.js";

/**
 * P18 (docs/lld/p18-profiles.md section 4.4): the profile module. Restore writes an archive into
 * a warm browser's empty profile directory before Chrome first opens it, and sets its cookies once
 * Chrome is up; save reads the cookies, closes Chrome cleanly so LevelDB and SQLite flush, and
 * answers the allowlisted files as one archive. Only browser-level CDP calls are made, before the
 * session's client can connect and after it has gone; no domain is enabled in any page.
 *
 * runtimed trusts nothing it is sent either: every path is checked again, every file is created
 * exclusively, without following a link, into a directory that must be empty.
 */

/** How long Chrome has to exit after `Browser.close` before it is killed and nothing is saved. */
export const CHROME_EXIT_MS = 5_000;
const COOKIES_PER_CALL = 500;

export class ProfileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- cookies ----------------------------------------------------------------------------

async function browserCdp<T>(
  port: number,
  fn: (cdp: Cdp) => Promise<T>,
): Promise<T> {
  const cdp = await Cdp.connect((await getVersion(port)).wsUrl, {
    maxPayload: 64 * 1024 * 1024,
  });
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

/** A CDP `Network.Cookie` as the archive keeps it: a `CookieParam`, or null if it cannot be set again. */
export function toCookieParam(
  c: Record<string, unknown>,
): ProfileCookie | null {
  if (c.partitionKeyOpaque === true) return null;
  let partitionKey: ProfileCookie["partitionKey"];
  if (typeof c.partitionKey === "string")
    partitionKey = {
      topLevelSite: c.partitionKey,
      hasCrossSiteAncestor: false,
    };
  else if (c.partitionKey && typeof c.partitionKey === "object") {
    const k = c.partitionKey as Record<string, unknown>;
    partitionKey = {
      topLevelSite: String(k.topLevelSite ?? ""),
      hasCrossSiteAncestor: k.hasCrossSiteAncestor === true,
    };
  }
  const parsed = ProfileCookie.safeParse({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
    ...(c.session === true || typeof c.expires !== "number" || c.expires < 0
      ? {}
      : { expires: c.expires }),
    ...(c.priority !== undefined ? { priority: c.priority } : {}),
    ...(c.sourceScheme !== undefined ? { sourceScheme: c.sourceScheme } : {}),
    ...(typeof c.sourcePort === "number" ? { sourcePort: c.sourcePort } : {}),
    ...(partitionKey ? { partitionKey } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Every cookie of the default context, read on the browser target. */
export async function readCookies(port: number): Promise<ProfileCookies> {
  const { cookies } = await browserCdp(port, (cdp) =>
    cdp.send<{ cookies: Record<string, unknown>[] }>(
      "Storage.getCookies",
      {},
      undefined,
      10_000,
    ),
  );
  const out: ProfileCookies = [];
  for (const c of cookies) {
    const p = toCookieParam(c);
    if (p) out.push(p);
  }
  if (out.length > PROFILE_LIMITS.maxCookies)
    throw new ProfileError(413, "too_large", "too many cookies");
  return out;
}

/** Set the restored cookies on the browser target. Returns how many. */
export async function writeCookies(
  port: number,
  cookies: ProfileCookies,
): Promise<number> {
  if (cookies.length === 0) return 0;
  await browserCdp(port, async (cdp) => {
    for (let i = 0; i < cookies.length; i += COOKIES_PER_CALL)
      await cdp.send(
        "Storage.setCookies",
        { cookies: cookies.slice(i, i + COOKIES_PER_CALL) },
        undefined,
        10_000,
      );
  });
  return cookies.length;
}

// --- files ------------------------------------------------------------------------------

/**
 * The allowlisted regular files under the profile directory, never following a link: only what
 * `PROFILE_ALLOW` names, without run-time files. Walks only directories on the way to an allowed
 * prefix, so Chrome's other state is never read.
 */
export async function collectProfileFiles(
  dir: string,
  maxBytes: number,
): Promise<{ path: string; data: Buffer }[]> {
  const out: { path: string; data: Buffer }[] = [];
  let total = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > PROFILE_LIMITS.maxDepth) return;
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Only into directories that can hold an allowed file.
        if (mayHoldAllowed(path)) await walk(path, depth + 1);
        continue;
      }
      if (!e.isFile() || profilePathProblem(path) !== null) continue;
      const data = await readRegular(join(dir, path));
      if (data === null) continue;
      total += data.length;
      if (
        out.length + 1 > PROFILE_LIMITS.maxFiles ||
        data.length > maxBytes ||
        total > maxBytes
      )
        throw new ProfileError(413, "too_large", "the profile is too large");
      out.push({ path, data });
    }
  };
  await walk("", 0);
  return out;
}

function mayHoldAllowed(dirPath: string): boolean {
  // A directory is worth entering if an allowed path could start with it, or it is under an
  // allowed directory. `profilePathProblem` decides about each file found.
  const probe = `${dirPath}/x`;
  return (
    ["Default", "Default/Local Storage"].includes(dirPath) ||
    profilePathProblem(probe) === null ||
    profilePathProblem(`${probe}/x`) === null
  );
}

async function readRegular(path: string): Promise<Buffer | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null; // a link, or gone
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    return await readFile(fh);
  } finally {
    await fh.close();
  }
}

/**
 * Write an archive into the empty profile directory as it streams in. Each path is checked
 * (again), directories are made one segment at a time and must be real directories, and each
 * file is created exclusively without following a link, mode 0600, with exactly its bytes.
 * Returns the cookies to set once Chrome is up.
 */
export async function restoreProfileArchive(
  dir: string,
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ cookies: ProfileCookies; files: number; bytes: number }> {
  if ((await readdir(dir)).length > 0)
    throw new ProfileError(
      409,
      "not_empty",
      "the profile directory is not empty",
    );
  const parser = new ProfileArchiveParser(maxBytes);
  let cookies: ProfileCookies = [];
  let fh: FileHandle | undefined;
  let files = 0;
  let bytes = 0;
  const made = new Set<string>();
  const ensureDirs = async (path: string) => {
    const segments = path.split("/").slice(0, -1);
    let cur = "";
    for (const s of segments) {
      cur = cur ? `${cur}/${s}` : s;
      if (made.has(cur)) continue;
      const full = join(dir, cur);
      try {
        await mkdir(full, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const st = await lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw new ProfileError(400, "invalid_archive", "not a directory");
      made.add(cur);
    }
  };
  try {
    for await (const chunk of body) {
      for (const part of parser.push(chunk)) {
        if (part.kind === "cookies") cookies = part.cookies;
        else if (part.kind === "file") {
          await fh?.close();
          fh = undefined;
          if (profilePathProblem(part.path) !== null)
            throw new ProfileError(400, "invalid_archive", "bad path");
          await ensureDirs(part.path);
          fh = await open(
            join(dir, part.path),
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          files++;
        } else if (part.kind === "data") {
          await fh!.write(part.data);
          bytes += part.data.length;
        } else if (part.kind === "end") {
          await fh?.close();
          fh = undefined;
        }
      }
    }
    parser.finish();
  } catch (e) {
    if (e instanceof ProfileArchiveError)
      throw new ProfileError(400, e.reason, e.message);
    if (e instanceof ProfileError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new ProfileError(
      400,
      code === "ENOSPC" ? "no_space" : "write_failed",
      code ?? "write failed",
    );
  } finally {
    await fh?.close().catch(() => undefined);
  }
  return { cookies, files, bytes };
}

// --- the module ---------------------------------------------------------------------------

/**
 * The profile half of one browser's life: at most one restore, before launch; at most one save,
 * after which Chrome is gone. A save is repeatable once Chrome has exited cleanly: the agent may
 * ask again after a restart, and gets the same archive.
 */
export class ProfileModule {
  private restored = false;
  private cookies: ProfileCookies = [];
  private saved: Buffer | null = null;
  private saving: Promise<Buffer> | null = null;
  /** Once Chrome has been closed, a failure is final: asking again gets the same answer. */
  private failure: ProfileError | null = null;

  constructor(
    private readonly dir: string,
    private readonly chromePort: number,
    private readonly supervisor: Supervisor,
    private readonly exitMs = CHROME_EXIT_MS,
  ) {}

  /** `PUT /profile`: only into a warm browser, once. */
  async restore(
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ files: number; bytes: number; cookies: number }> {
    if (this.supervisor.state !== "warm" || this.restored)
      throw new ProfileError(
        409,
        "not_warm",
        "Chrome has started, or a profile was written",
      );
    this.restored = true;
    const r = await restoreProfileArchive(
      this.dir,
      body,
      PROFILE_LIMITS.maxBytesCeiling,
    );
    this.cookies = r.cookies;
    return { files: r.files, bytes: r.bytes, cookies: r.cookies.length };
  }

  /** `POST /launch`: start Chrome, then set the restored cookies before anyone can connect. */
  async launch(viewport: {
    width: number;
    height: number;
  }): Promise<{ chromeVersion: string; cookies: number }> {
    if (this.supervisor.state !== "warm")
      throw new ProfileError(409, "not_warm", "not a warm browser");
    await this.supervisor.launch(viewport);
    if (!this.supervisor.chromeReady || !this.supervisor.chromeVersion)
      throw new ProfileError(500, "launch_failed", "Chrome did not start");
    const n = await writeCookies(this.chromePort, this.cookies);
    this.cookies = [];
    return { chromeVersion: this.supervisor.chromeVersion, cookies: n };
  }

  /** `POST /profile/save`. */
  async save(maxBytes = PROFILE_LIMITS.maxBytesCeiling): Promise<Buffer> {
    if (this.saved) return this.saved;
    if (this.failure) throw this.failure;
    if (this.saving) return this.saving;
    if (this.supervisor.state !== "ready")
      throw new ProfileError(409, "not_running", "Chrome is not running");
    this.saving = this.doSave(maxBytes).finally(() => (this.saving = null));
    return this.saving;
  }

  private async doSave(maxBytes: number): Promise<Buffer> {
    const cookies = await readCookies(this.chromePort);
    const how = await this.supervisor.closeChrome(
      () =>
        browserCdp(this.chromePort, (cdp) =>
          cdp.send("Browser.close", {}, undefined, 2_000),
        ),
      this.exitMs,
    );
    try {
      if (how !== "exited")
        throw new ProfileError(409, "unclean", "Chrome did not exit in time");
      const files = await collectProfileFiles(this.dir, maxBytes);
      this.saved = encodeProfileArchive(cookies, files);
      return this.saved;
    } catch (e) {
      this.failure =
        e instanceof ProfileError
          ? e
          : new ProfileError(
              500,
              "read_failed",
              "the profile could not be read",
            );
      throw this.failure;
    }
  }
}
