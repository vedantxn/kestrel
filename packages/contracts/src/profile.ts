import { z } from "zod";
import { ProfileId, SessionId } from "./ids.js";
import { PlainText } from "./plain-text.js";
import { Metadata } from "./session.js";

/**
 * P18 (docs/lld/p18-profiles.md). A profile is a project's saved browser state: the cookies,
 * `localStorage` and IndexedDB of a session's default browser context, kept encrypted per
 * project. Sessions read it with `profile: { id }` and write its next version with
 * `profile: { id, persist: true }`, one writer at a time.
 */

const MiB = 1024 * 1024;

export const PROFILE_LIMITS = {
  /** Bytes of files in one version, besides `cookies.json`. A deployment may raise it to `maxBytesCeiling`. */
  maxBytes: 64 * MiB,
  maxBytesCeiling: 256 * MiB,
  maxFiles: 4096,
  /** A file's path, in bytes, and its depth in segments; each segment at most `maxSegmentBytes`. */
  maxPathBytes: 255,
  maxDepth: 8,
  maxSegmentBytes: 128,
  maxCookies: 5000,
  cookiesBytes: 4 * MiB,
  /** The archive's JSON manifest. */
  manifestBytes: 1 * MiB,
  /** Per project: live profiles, and the bytes of their current versions together. */
  maxProfilesPerProject: 100,
  maxProjectBytes: 5 * 1024 * MiB,
  /** How long the node waits for a browser's save, Chrome's exit included. */
  saveMs: 15_000,
  /** A superseded version is kept this long, for readers that started on it, then collected. */
  supersededKeepMs: 10 * 60_000,
} as const;

const IsoTime = z.iso.datetime({ offset: true });

export const Profile = z
  .object({
    id: ProfileId,
    name: z.string().nullable(),
    metadata: Metadata,
    version: z
      .number()
      .int()
      .nonnegative()
      .describe("The current version. 0 until a session has saved one."),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("The current version's stored size; 0 if none."),
    savedAt: IsoTime.nullable(),
    savedBySessionId: SessionId.nullable(),
    chromeMajor: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        "The Chrome major version that saved the current version. Only the same or a newer Chrome opens it.",
      ),
    inUseBy: SessionId.nullable().describe(
      "The session that will save the next version (`persist: true`), if one is running.",
    ),
    createdAt: IsoTime,
  })
  .meta({ id: "Profile" });
export type Profile = z.infer<typeof Profile>;

export const CreateProfileRequest = z
  .strictObject({
    name: PlainText(1, 100)
      .optional()
      .describe("Unique among the project's profiles."),
    metadata: Metadata.optional(),
  })
  .meta({ id: "CreateProfileRequest" });
export type CreateProfileRequest = z.infer<typeof CreateProfileRequest>;

export const ListProfilesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .meta({ id: "ListProfilesQuery" });
export type ListProfilesQuery = z.infer<typeof ListProfilesQuery>;

export const ListProfilesResponse = z
  .object({ data: z.array(Profile), nextCursor: z.string().nullable() })
  .meta({ id: "ListProfilesResponse" });
export type ListProfilesResponse = z.infer<typeof ListProfilesResponse>;

/** Why a writer session's state was not saved (`profile.save_failed`). */
export const PROFILE_SAVE_FAILURES = [
  "unclean_end", // the session ended in a way that does not save (a crash, a lost node)
  "not_started", // it never became ready
  "browser_gone", // the browser was gone when the save was asked for
  "chrome_did_not_exit", // Chrome did not exit cleanly within the budget
  "timeout", // the save did not finish within its budget
  "too_large", // past the profile's size or count limits
  "invalid_archive", // the browser's answer failed the archive checks
  "storage_full", // the profile store is out of space
  "storage_error", // the profile store failed otherwise
  "project_quota", // the project's profiles would pass its byte quota
  "deleted", // the profile was deleted while the session ran
  "stale", // the profile moved on without this session (its lock had been released)
  "node_lost", // the session's node was lost
  "no_report", // the node finished the session without reporting a save
] as const;
export const ProfileSaveFailure = z.enum(PROFILE_SAVE_FAILURES);
export type ProfileSaveFailure = z.infer<typeof ProfileSaveFailure>;

/** A 32-byte data key, base64. Sent to a node only inside `StartRequest.profile`. */
export const Base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, "a 32-byte base64 key");
export type Base64Key32 = z.infer<typeof Base64Key32>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
