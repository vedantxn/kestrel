import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

/**
 * P18 (docs/lld/p18-profiles.md section 4.5): an envelope. One master key on the host; a key per
 * project derived from it with HKDF; a random data key per profile version, stored only wrapped
 * with the project's key; and the version's blob sealed with its data key. The API holds the
 * master key and unwraps; the node agent seals and opens with the data keys it is sent.
 *
 * Blob (`.kpf`): a 64-byte header, then AES-256-GCM(dataKey, nonce, gzip(archive), aad = header),
 * then the 16-byte tag.
 *
 *   0  "KPF1"           4
 *   4  format (1)       1
 *   5  reserved (0)     3
 *   8  project uuid    16
 *  24  profile uuid    16
 *  40  version (u32)    4
 *  44  reserved (0)     8
 *  52  nonce           12
 */
export const PROFILE_BLOB_HEADER_BYTES = 64;
const MAGIC = Buffer.from("KPF1");
const FORMAT = 1;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const KEK_SALT = Buffer.from("kestrel-profile-kek");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class ProfileCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileCryptoError";
  }
}

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new ProfileCryptoError("not a uuid");
  return Buffer.from(hex, "hex");
}

function checkKey(key: Uint8Array, what: string): void {
  if (key.length !== KEY_BYTES)
    throw new ProfileCryptoError(`${what} must be 32 bytes`);
}

function versionBytes(version: number): Buffer {
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff)
    throw new ProfileCryptoError("bad version");
  const b = Buffer.alloc(4);
  b.writeUInt32BE(version);
  return b;
}

/** The project's key-encryption key: HKDF-SHA256(master, salt, info = project uuid). */
export function deriveProjectKey(
  master: Uint8Array,
  projectUuid: string,
): Buffer {
  checkKey(master, "the master key");
  return Buffer.from(
    hkdfSync("sha256", master, KEK_SALT, Buffer.from(projectUuid), KEY_BYTES),
  );
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** nonce ‖ ciphertext ‖ tag, bound to the profile and version (60 bytes). */
export function wrapDataKey(
  kek: Uint8Array,
  dataKey: Uint8Array,
  profileUuid: string,
  version: number,
): Buffer {
  checkKey(kek, "the project key");
  checkKey(dataKey, "a data key");
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv("aes-256-gcm", kek, nonce);
  c.setAAD(Buffer.concat([uuidBytes(profileUuid), versionBytes(version)]));
  const ct = Buffer.concat([c.update(dataKey), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export function unwrapDataKey(
  kek: Uint8Array,
  wrapped: Uint8Array,
  profileUuid: string,
  version: number,
): Buffer {
  checkKey(kek, "the project key");
  if (wrapped.length !== NONCE_BYTES + KEY_BYTES + TAG_BYTES)
    throw new ProfileCryptoError("wrapped key has the wrong length");
  const w = Buffer.from(wrapped);
  const d = createDecipheriv("aes-256-gcm", kek, w.subarray(0, NONCE_BYTES));
  d.setAAD(Buffer.concat([uuidBytes(profileUuid), versionBytes(version)]));
  d.setAuthTag(w.subarray(NONCE_BYTES + KEY_BYTES));
  try {
    return Buffer.concat([
      d.update(w.subarray(NONCE_BYTES, NONCE_BYTES + KEY_BYTES)),
      d.final(),
    ]);
  } catch {
    throw new ProfileCryptoError("the data key does not unwrap");
  }
}

export interface ProfileBlobIds {
  projectUuid: string;
  profileUuid: string;
  version: number;
}

function header(ids: ProfileBlobIds, nonce: Buffer): Buffer {
  const h = Buffer.alloc(PROFILE_BLOB_HEADER_BYTES);
  MAGIC.copy(h, 0);
  h.writeUInt8(FORMAT, 4);
  uuidBytes(ids.projectUuid).copy(h, 8);
  uuidBytes(ids.profileUuid).copy(h, 24);
  versionBytes(ids.version).copy(h, 40);
  nonce.copy(h, 52);
  return h;
}

/** gzip the archive and seal it for exactly this project, profile and version. */
export async function sealProfileBlob(
  dataKey: Uint8Array,
  ids: ProfileBlobIds,
  archive: Uint8Array,
): Promise<Buffer> {
  checkKey(dataKey, "a data key");
  const h = header(ids, randomBytes(NONCE_BYTES));
  const zipped = await gzipAsync(archive);
  const c = createCipheriv("aes-256-gcm", dataKey, h.subarray(52, 64));
  c.setAAD(h);
  const ct = Buffer.concat([c.update(zipped), c.final()]);
  return Buffer.concat([h, ct, c.getAuthTag()]);
}

/**
 * Open a blob as exactly this project, profile and version. The header is rebuilt from the ids
 * the caller holds, so a blob moved to another profile, project or version fails its tag. Nothing
 * is decompressed before the tag verifies, and decompression stops past `maxArchiveBytes`.
 */
export async function openProfileBlob(
  dataKey: Uint8Array,
  ids: ProfileBlobIds,
  blob: Uint8Array,
  maxArchiveBytes: number,
): Promise<Buffer> {
  checkKey(dataKey, "a data key");
  if (blob.length < PROFILE_BLOB_HEADER_BYTES + TAG_BYTES)
    throw new ProfileCryptoError("blob too short");
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const got = b.subarray(0, PROFILE_BLOB_HEADER_BYTES);
  const want = header(ids, got.subarray(52, 64));
  // A wrong header fails the tag anyway; refusing it first gives a clearer reason.
  if (!got.equals(want))
    throw new ProfileCryptoError("blob header does not match its ids");
  const d = createDecipheriv("aes-256-gcm", dataKey, got.subarray(52, 64));
  d.setAAD(want);
  d.setAuthTag(b.subarray(b.length - TAG_BYTES));
  let zipped: Buffer;
  try {
    zipped = Buffer.concat([
      d.update(b.subarray(PROFILE_BLOB_HEADER_BYTES, b.length - TAG_BYTES)),
      d.final(),
    ]);
  } catch {
    throw new ProfileCryptoError("blob does not decrypt");
  }
  try {
    return await gunzipAsync(zipped, { maxOutputLength: maxArchiveBytes });
  } catch {
    throw new ProfileCryptoError("blob does not decompress within its cap");
  }
}
