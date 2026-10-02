import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * TypeIDs: a readable prefix, an underscore, and a UUIDv7 encoded as 26 characters of
 * lowercase Crockford base32 (https://github.com/jetify-com/typeid). The database stores
 * the bare UUID; the prefix is added on the way out, so an id read in a log or an error
 * says what it names.
 */
export const ID_PREFIXES = {
  org: "org",
  project: "prj",
  apiKey: "key",
  node: "nod",
  session: "ses",
  event: "evt",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SUFFIX_RE = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** Encode 16 bytes as 26 base32 characters (128 bits, left-padded to 130). */
function encodeBase32(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function decodeBase32(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) n = (n << 5n) | BigInt(ALPHABET.indexOf(ch));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

/** A UUIDv7: 48-bit millisecond timestamp, version, variant, random remainder. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 255n);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId(prefix: IdPrefix, nowMs?: number): string {
  return uuidToId(prefix, uuidv7(nowMs));
}

export function uuidToId(prefix: IdPrefix, uuid: string): string {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return `${prefix}_${encodeBase32(Buffer.from(hex, "hex"))}`;
}

/** The UUID inside an id, for storing in a `uuid` column. Throws if the id is malformed. */
export function idToUuid(id: string): string {
  const i = id.lastIndexOf("_");
  const suffix = id.slice(i + 1);
  if (i < 1 || !SUFFIX_RE.test(suffix)) throw new Error(`malformed id: ${id}`);
  const hex = Buffer.from(decodeBase32(suffix)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idSchema<P extends IdPrefix>(prefix: P) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`),
      `must be a ${prefix}_ id`,
    )
    .brand<P>();
}

export const SessionId = idSchema(ID_PREFIXES.session);
export const ProjectId = idSchema(ID_PREFIXES.project);
export const OrgId = idSchema(ID_PREFIXES.org);
export const ApiKeyId = idSchema(ID_PREFIXES.apiKey);
export const EventId = idSchema(ID_PREFIXES.event);

/**
 * Node ids are chosen by configuration, not generated ("a", "b" in v1), because they name
 * host resources such as interfaces, firewall chains and sockets.
 */
export const NodeId = z
  .string()
  .regex(
    /^[a-z][a-z0-9]{0,15}$/,
    "lowercase letters and digits, at most 16 characters",
  )
  .brand<"NodeId">();

export type SessionId = z.infer<typeof SessionId>;
export type ProjectId = z.infer<typeof ProjectId>;
export type OrgId = z.infer<typeof OrgId>;
export type ApiKeyId = z.infer<typeof ApiKeyId>;
export type EventId = z.infer<typeof EventId>;
export type NodeId = z.infer<typeof NodeId>;
