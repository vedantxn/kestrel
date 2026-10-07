import { z } from "zod";
import { PROFILE_LIMITS } from "./profile.js";

/**
 * C5 / C11. The profile archive (docs/lld/p18-profiles.md section 4.4): the same bytes on the
 * wire between the node agent and runtimed, in both directions, and inside the encrypted blob.
 *
 *   u32 big-endian  manifest length (at most 1 MiB)
 *   manifest        JSON, ProfileManifest
 *   cookies.json    exactly manifest.cookies.bytes
 *   file bytes      back to back, in manifest order, exactly manifest.files[i].bytes each
 *
 * An archive read back from a browser is hostile input (principle 2): the agent and runtimed
 * both parse it with `ProfileArchiveParser`, which checks every rule here before a byte of a
 * file is handed on. There are no directory entries, links or modes: each file is a regular
 * file, 0600, and its directories are made when it is written.
 */

/**
 * What a profile keeps, relative to Chrome's `--user-data-dir`. An entry ending in `/` admits
 * every file under that directory; any other names one file, together with its SQLite
 * `-journal` and `-wal`. Both `localStorage` layouts are here: LevelDB in older Chromes, one
 * SQLite file in newer ones (spike S1).
 */
export const PROFILE_ALLOW = [
  "Default/Local Storage/leveldb/",
  "Default/LocalStorage",
  "Default/IndexedDB/",
  "Default/WebStorage/",
] as const;

/** Run-time files never carried, wherever they are. */
export const PROFILE_DENY_NAMES = ["LOCK", "LOG", "LOG.old"] as const;

const SQLITE_COMPANIONS = ["", "-journal", "-wal"];

/** The archive's own name for the cookies part, never a file in the profile. */
export const PROFILE_COOKIES_NAME = "cookies.json";

const SEGMENT_RE = /^[A-Za-z0-9 ._-]+$/;

/** Why a path is refused, or null if it is a path a profile may hold. */
export function profilePathProblem(path: string): string | null {
  if (Buffer.byteLength(path) > PROFILE_LIMITS.maxPathBytes)
    return "path too long";
  const segments = path.split("/");
  if (segments.length > PROFILE_LIMITS.maxDepth) return "path too deep";
  for (const s of segments) {
    if (s.length === 0) return "empty segment";
    if (s === "." || s === "..") return "dot segment";
    if (s.length > PROFILE_LIMITS.maxSegmentBytes) return "segment too long";
    if (!SEGMENT_RE.test(s)) return "bad character";
  }
  if ((PROFILE_DENY_NAMES as readonly string[]).includes(segments.at(-1)!))
    return "denied name";
  const allowed = PROFILE_ALLOW.some((a) =>
    a.endsWith("/")
      ? path.startsWith(a) && path.length > a.length
      : SQLITE_COMPANIONS.some((c) => path === a + c),
  );
  return allowed ? null : "not in the allowlist";
}

export const ProfilePath = z
  .string()
  .max(PROFILE_LIMITS.maxPathBytes)
  .superRefine((p, ctx) => {
    const problem = profilePathProblem(p);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const ProfileManifest = z.strictObject({
  format: z.literal(1),
  cookies: z.strictObject({
    bytes: z.number().int().min(0).max(PROFILE_LIMITS.cookiesBytes),
    count: z.number().int().min(0).max(PROFILE_LIMITS.maxCookies),
  }),
  files: z
    .array(
      z.strictObject({
        path: ProfilePath,
        bytes: z.number().int().min(0).max(PROFILE_LIMITS.maxBytesCeiling),
      }),
    )
    .max(PROFILE_LIMITS.maxFiles),
});
export type ProfileManifest = z.infer<typeof ProfileManifest>;

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NO_CONTROL = /^[^\u0000-\u0008\u000a-\u001f\u007f]*$/;
const CookieText = (max: number) => z.string().max(max).regex(NO_CONTROL);

/**
 * One cookie, as CDP's `Network.CookieParam` takes it, with bounded strings. `expires` is
 * absent for a session cookie. Written by `Storage.getCookies` at save and given to
 * `Storage.setCookies` at launch.
 */
export const ProfileCookie = z.strictObject({
  name: CookieText(4096),
  value: CookieText(4096),
  domain: CookieText(253).min(1),
  path: CookieText(1024).min(1),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  expires: z.number().finite().nonnegative().max(1e11).optional(),
  priority: z.enum(["Low", "Medium", "High"]).optional(),
  sourceScheme: z.enum(["Unset", "NonSecure", "Secure"]).optional(),
  sourcePort: z.number().int().min(-1).max(65535).optional(),
  partitionKey: z
    .strictObject({
      topLevelSite: CookieText(300),
      hasCrossSiteAncestor: z.boolean(),
    })
    .optional(),
});
export type ProfileCookie = z.infer<typeof ProfileCookie>;

export const ProfileCookies = z
  .array(ProfileCookie)
  .max(PROFILE_LIMITS.maxCookies);
export type ProfileCookies = z.infer<typeof ProfileCookies>;

export type ProfileArchiveFailure = "invalid_archive" | "too_large";

export class ProfileArchiveError extends Error {
  constructor(
    readonly reason: ProfileArchiveFailure,
    message: string,
  ) {
    super(message);
    this.name = "ProfileArchiveError";
  }
}

/**
 * The checks a manifest needs beyond its schema: no duplicate paths, no file that is also a
 * directory of another, and the total against the caller's byte cap (the deployment's
 * `PROFILE_MAX_BYTES`, sent with each start). Throws `ProfileArchiveError`.
 */
export function checkProfileManifest(
  raw: unknown,
  maxBytes: number,
): ProfileManifest {
  const parsed = ProfileManifest.safeParse(raw);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some(
      (i) =>
        i.code === "too_big" &&
        // a long path is a bad path, not a large profile
        !i.path.includes("path"),
    );
    throw new ProfileArchiveError(
      tooBig ? "too_large" : "invalid_archive",
      `manifest: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const m = parsed.data;
  const paths = new Set<string>();
  let total = 0;
  for (const f of m.files) {
    if (paths.has(f.path))
      throw new ProfileArchiveError("invalid_archive", "duplicate path");
    paths.add(f.path);
    total += f.bytes;
  }
  for (const p of paths) {
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join("/")))
        throw new ProfileArchiveError(
          "invalid_archive",
          "a file is also a directory",
        );
    }
  }
  if (total > maxBytes)
    throw new ProfileArchiveError("too_large", "files past the byte cap");
  return m;
}

/** The archive's length for a manifest, and the most any archive may be for a byte cap. */
export function profileArchiveBytes(
  manifestJsonBytes: number,
  m: ProfileManifest,
): number {
  return (
    4 +
    manifestJsonBytes +
    m.cookies.bytes +
    m.files.reduce((n, f) => n + f.bytes, 0)
  );
}

export function maxProfileArchiveBytes(maxBytes: number): number {
  return (
    4 + PROFILE_LIMITS.manifestBytes + PROFILE_LIMITS.cookiesBytes + maxBytes
  );
}

/** The archive's head: the length prefix and the manifest. Cookies and files follow it. */
export function encodeProfileArchiveHead(m: ProfileManifest): Buffer {
  const json = Buffer.from(JSON.stringify(m));
  if (json.length > PROFILE_LIMITS.manifestBytes)
    throw new ProfileArchiveError("too_large", "manifest past 1 MiB");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

/** A whole archive in memory, for tests and small callers. */
export function encodeProfileArchive(
  cookies: ProfileCookies,
  files: { path: string; data: Uint8Array }[],
): Buffer {
  const cookiesJson = Buffer.from(JSON.stringify(cookies));
  const head = encodeProfileArchiveHead({
    format: 1,
    cookies: { bytes: cookiesJson.length, count: cookies.length },
    files: files.map((f) => ({ path: f.path, bytes: f.data.length })),
  });
  return Buffer.concat([head, cookiesJson, ...files.map((f) => f.data)]);
}

export type ProfileArchivePart =
  | { kind: "manifest"; manifest: ProfileManifest }
  | { kind: "cookies"; cookies: ProfileCookies }
  | { kind: "file"; index: number; path: string; bytes: number }
  | { kind: "data"; index: number; data: Buffer }
  | { kind: "end" };

/**
 * A push parser: feed it the body in chunks of any size, and it returns the parts each chunk
 * completes. The manifest is checked before anything after it is returned; `cookies.json` is
 * held (at most 4 MiB) and checked whole; file bytes are passed on as they come, never more
 * than the manifest said. `finish()` throws unless the body ended exactly at the last byte. One
 * byte past the end is refused at once.
 */
export class ProfileArchiveParser {
  private stage: "len" | "manifest" | "cookies" | "files" | "done" = "len";
  private buf: Buffer[] = [];
  private buffered = 0;
  private need = 4;
  private manifest: ProfileManifest | undefined;
  private file = 0;
  private fileLeft = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): ProfileArchivePart[] {
    const out: ProfileArchivePart[] = [];
    let c = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (c.length > 0) {
      if (this.stage === "done")
        throw new ProfileArchiveError(
          "invalid_archive",
          "bytes past the archive's end",
        );
      if (this.stage === "files") {
        const n = Math.min(this.fileLeft, c.length);
        out.push({ kind: "data", index: this.file, data: c.subarray(0, n) });
        c = c.subarray(n);
        this.fileLeft -= n;
        this.nextFile(out);
        continue;
      }
      const n = Math.min(this.need - this.buffered, c.length);
      this.buf.push(c.subarray(0, n));
      this.buffered += n;
      c = c.subarray(n);
      if (this.buffered === this.need) this.complete(out);
    }
    return out;
  }

  /** The body ended. Throws if it ended early. */
  finish(): void {
    if (this.stage !== "done")
      throw new ProfileArchiveError("invalid_archive", "archive cut short");
  }

  private take(): Buffer {
    const b = Buffer.concat(this.buf);
    this.buf = [];
    this.buffered = 0;
    return b;
  }

  private complete(out: ProfileArchivePart[]): void {
    const b = this.take();
    if (this.stage === "len") {
      const len = b.readUInt32BE(0);
      if (len === 0 || len > PROFILE_LIMITS.manifestBytes)
        throw new ProfileArchiveError(
          len === 0 ? "invalid_archive" : "too_large",
          "manifest length",
        );
      this.stage = "manifest";
      this.need = len;
      return;
    }
    if (this.stage === "manifest") {
      let json: unknown;
      try {
        json = JSON.parse(b.toString("utf8"));
      } catch {
        throw new ProfileArchiveError(
          "invalid_archive",
          "manifest is not JSON",
        );
      }
      this.manifest = checkProfileManifest(json, this.maxBytes);
      out.push({ kind: "manifest", manifest: this.manifest });
      this.stage = "cookies";
      this.need = this.manifest.cookies.bytes;
      if (this.need === 0) this.complete(out);
      return;
    }
    // cookies
    const m = this.manifest!;
    let json: unknown;
    try {
      json = b.length === 0 ? [] : JSON.parse(b.toString("utf8"));
    } catch {
      throw new ProfileArchiveError("invalid_archive", "cookies are not JSON");
    }
    const cookies = ProfileCookies.safeParse(json);
    if (!cookies.success || cookies.data.length !== m.cookies.count)
      throw new ProfileArchiveError("invalid_archive", "cookies");
    out.push({ kind: "cookies", cookies: cookies.data });
    this.stage = "files";
    this.file = -1;
    this.fileLeft = 0;
    this.nextFile(out);
  }

  /** Move past finished files (empty ones included), announcing each new one. */
  private nextFile(out: ProfileArchivePart[]): void {
    const files = this.manifest!.files;
    while (this.fileLeft === 0) {
      this.file++;
      if (this.file >= files.length) {
        this.stage = "done";
        out.push({ kind: "end" });
        return;
      }
      const f = files[this.file]!;
      out.push({
        kind: "file",
        index: this.file,
        path: f.path,
        bytes: f.bytes,
      });
      this.fileLeft = f.bytes;
    }
  }
}

/** Parse a whole archive held in memory. Throws `ProfileArchiveError`. */
export function parseProfileArchive(
  body: Uint8Array,
  maxBytes: number,
): {
  manifest: ProfileManifest;
  cookies: ProfileCookies;
  files: { path: string; data: Buffer }[];
} {
  const p = new ProfileArchiveParser(maxBytes);
  const parts = p.push(body);
  p.finish();
  let manifest: ProfileManifest | undefined;
  let cookies: ProfileCookies = [];
  const files: { path: string; chunks: Buffer[] }[] = [];
  for (const part of parts) {
    if (part.kind === "manifest") manifest = part.manifest;
    else if (part.kind === "cookies") cookies = part.cookies;
    else if (part.kind === "file") files.push({ path: part.path, chunks: [] });
    else if (part.kind === "data") files[part.index]!.chunks.push(part.data);
  }
  return {
    manifest: manifest!,
    cookies,
    files: files.map((f) => ({ path: f.path, data: Buffer.concat(f.chunks) })),
  };
}
