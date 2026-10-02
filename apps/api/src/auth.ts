import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { API_KEY_PREFIX, ApiKeySecret } from "@kestrel/contracts";
import type { PrismaClient } from "@kestrel/db";
import type { Clock } from "@kestrel/shared";
import type { Auth } from "./context.js";
import { AppError } from "./errors.js";
import { newUuid } from "./ids.js";

/** A8. Only a SHA-256 hash is stored; long random keys make a fast hash safe. */
export const hashKey = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** Constant-time comparison of two secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Pull the key out of `Authorization: Bearer` or `x-api-key`. */
export function extractKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  const x = headers["x-api-key"];
  return typeof x === "string" ? x.trim() : null;
}

const LAST_USED_EVERY_MS = 60_000;
const UNAUTHORIZED =
  "A valid API key is required: Authorization: Bearer ksl_...";

export async function authenticate(
  db: PrismaClient,
  clock: Clock,
  headers: Record<string, string | string[] | undefined>,
): Promise<Auth> {
  const key = extractKey(headers);
  if (!key || !ApiKeySecret.safeParse(key).success)
    throw new AppError("unauthorized", UNAUTHORIZED);
  const row = await db.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!row || row.revokedAt) throw new AppError("unauthorized", UNAUTHORIZED);
  const now = clock.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await db.apiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(now) },
    });
  }
  return { projectId: row.projectId, apiKeyId: row.id };
}

/** For the admin command and tests: make a key and store its hash. The key is returned once. */
export async function createApiKey(
  db: PrismaClient,
  projectId: string,
  name: string,
  now: Date,
) {
  const key = generateApiKey();
  const id = newUuid();
  await db.apiKey.create({
    data: {
      id,
      projectId,
      name,
      prefix: key.slice(0, 8),
      keyHash: hashKey(key),
      createdAt: now,
    },
  });
  return { key, id };
}
