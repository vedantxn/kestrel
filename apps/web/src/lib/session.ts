import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * The dashboard's sign-in (P17, threat model T-66): the API key, sealed in a JWE (`dir`,
 * A256GCM) under a server-side secret. The browser holds only ciphertext it cannot read or forge.
 */
export interface WebSession {
  apiKey: string;
  projectId: string;
  admin: boolean;
}

export const SESSION_COOKIE = "kestrel_session";
export const SESSION_TTL_S = 12 * 3600;

const ISSUER = "kestrel-web";

/** Any secret string becomes a 256-bit key; it should itself be long and random. */
export function sessionKey(secret: string): Uint8Array {
  if (secret.length < 32)
    throw new Error("the session secret must be at least 32 characters");
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export async function sealSession(
  s: WebSession,
  key: Uint8Array,
  nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new EncryptJWT({ k: s.apiKey, p: s.projectId, a: s.admin })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(ISSUER)
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + SESSION_TTL_S)
    .encrypt(key);
}

/** The session, or null if the cookie is missing, tampered with, under another key or expired. */
export async function openSession(
  token: string | undefined,
  key: Uint8Array,
  nowS = Math.floor(Date.now() / 1000),
): Promise<WebSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key, {
      issuer: ISSUER,
      currentDate: new Date(nowS * 1000),
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    const { k, p, a } = payload;
    if (
      typeof k !== "string" ||
      typeof p !== "string" ||
      typeof a !== "boolean"
    )
      return null;
    return { apiKey: k, projectId: p, admin: a };
  } catch {
    return null;
  }
}
