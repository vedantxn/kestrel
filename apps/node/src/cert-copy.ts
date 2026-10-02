import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import {
  chownSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * G16, threat model G-08. Caddy stores its certificate and key readable only by itself, at a path
 * that depends on the certificate authority. The agent (root) finds the pair for the hostname,
 * checks it is a regular file it may trust, checks the key matches the certificate, and copies
 * both atomically into a directory the gateway can read. The key is never logged.
 */
const MAX_BYTES = 64 * 1024;

function readRegular(path: string): string {
  // O_NOFOLLOW: a symlink planted in Caddy's tree must not be followed to some other file.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > MAX_BYTES) throw new Error(`${path} is too large`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Caddy keeps `certificates/<issuer>/<host>/<host>.crt` and `.key`. */
export function findCaddyPair(
  caddyData: string,
  hostname: string,
): { cert: string; key: string } | null {
  // The hostname becomes part of a path: only an ordinary hostname may.
  if (
    !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname) ||
    hostname.includes("..")
  )
    return null;
  const root = join(caddyData, "caddy", "certificates");
  let issuers: string[];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    issuers = readdirSync(root);
  } catch {
    return null;
  }
  for (const issuer of issuers.sort()) {
    const cert = join(root, issuer, hostname, `${hostname}.crt`);
    const key = join(root, issuer, hostname, `${hostname}.key`);
    try {
      // O_NOFOLLOW covers only the last component, so also require that the directories on the way,
      // once resolved, are still inside Caddy's certificate tree (a symlinked issuer directory is not).
      for (const f of [cert, key])
        if (!realpathSync(f).startsWith(realRoot + "/"))
          throw new Error("outside the certificate tree");
      readRegular(cert);
      readRegular(key);
      return { cert, key };
    } catch {
      /* try the next issuer */
    }
  }
  return null;
}

export interface CopyResult {
  copied: boolean;
  reason?: string;
}

/** Copy the pair for `hostname` into `outDir` (cert.pem, key.pem) if it is valid and has changed. */
export function copyCertificate(opts: {
  caddyData: string;
  hostname: string;
  outDir: string;
  /** The gateway's uid and gid, who must be able to read the key. */
  owner?: { uid: number; gid: number };
}): CopyResult {
  const found = findCaddyPair(opts.caddyData, opts.hostname);
  if (!found)
    return { copied: false, reason: "no certificate for the hostname yet" };
  let cert: string;
  let key: string;
  try {
    cert = readRegular(found.cert);
    key = readRegular(found.key);
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)))
      return { copied: false, reason: "certificate and key do not match" };
  } catch (e) {
    return {
      copied: false,
      reason: e instanceof Error ? e.message : "unreadable",
    };
  }
  mkdirSync(opts.outDir, { recursive: true, mode: 0o750 });
  // The gateway must be able to enter the directory to read what is in it.
  if (opts.owner) chownSync(opts.outDir, opts.owner.uid, opts.owner.gid);
  const same = (name: string, data: string): boolean => {
    try {
      return readFileSync(join(opts.outDir, name), "utf8") === data;
    } catch {
      return false;
    }
  };
  if (same("cert.pem", cert) && same("key.pem", key))
    return { copied: false, reason: "unchanged" };
  // Write the key first and the certificate last, each by rename, so a reader never sees a new
  // certificate beside the old key for longer than one rename.
  for (const [name, data, mode] of [
    ["key.pem", key, 0o600],
    ["cert.pem", cert, 0o644],
  ] as const) {
    // An unpredictable name, created exclusively and without following a link: nothing planted at the
    // temporary path can receive the private key.
    const tmp = join(
      opts.outDir,
      `.${name}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    if (opts.owner) chownSync(tmp, opts.owner.uid, opts.owner.gid);
    renameSync(tmp, join(opts.outDir, name));
  }
  return { copied: true };
}
