import { z } from "zod";
import { ProjectId, NodeId, SessionId } from "./ids.js";

/**
 * C3. Tokens and the session proof.
 *
 * The API holds the Ed25519 private key and signs; gateways hold only the public key, so a
 * gateway can verify with the API down and can never mint (C9). A token names one session,
 * project and node, has a scope, and expires one minute after the session's own deadline (C8).
 * Revocation is removing the session's route; tokens are never extended or rotated.
 *
 * v2 (W1): `view` and `control` tokens open live view, with a shorter lifetime chosen by the
 * caller. A single-use token carries a random `jti` that the gateway remembers until it expires.
 */
export const TOKEN_ALG = "EdDSA";
export const TOKEN_ISSUER = "kestrel";

/** `cdp` opens the CDP socket; `view` opens live view; `control` opens live view with input. */
export const TOKEN_SCOPES = ["cdp", "view", "control"] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

export const TokenClaims = z
  .object({
    iss: z.literal(TOKEN_ISSUER),
    sub: SessionId,
    prj: ProjectId,
    nod: NodeId,
    scope: TokenScope,
    iat: z.number().int(),
    exp: z.number().int(),
    /** Present on single-use tokens only. */
    jti: z.string().min(16).max(64).optional(),
    once: z.literal(true).optional(),
  })
  .meta({ id: "TokenClaims" });
export type TokenClaims = z.infer<typeof TokenClaims>;

/**
 * C10. 32 random bytes per session, made by the node agent and given to the gateway (in the
 * route) and to the container (at configure time). The container's CDP forward refuses a
 * connection that does not present it, so a stale route to a reused address reaches nothing.
 */
export const SessionProof = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "64 hex characters");
export type SessionProof = z.infer<typeof SessionProof>;

/** The header the gateway sends to the container's CDP forward with the proof. */
export const PROOF_HEADER = "x-kestrel-session-proof";

/** A (long, random) API key (A8): `ksl_` and 43 characters of base64url, 256 bits. Only a SHA-256 hash is stored. */
export const API_KEY_PREFIX = "ksl_";
export const ApiKeySecret = z.string().regex(/^ksl_[A-Za-z0-9_-]{43}$/);
export type ApiKeySecret = z.infer<typeof ApiKeySecret>;

/** W1. Lifetimes for tokens minted through `POST /v1/sessions/{id}/tokens`. */
export const TOKEN_TTL = {
  liveDefaultMs: 10 * 60_000,
  liveMaxMs: 60 * 60_000,
  /** A gateway restart forgets which single-use tokens were spent, so they live only briefly. */
  singleUseMaxMs: 5 * 60_000,
  minMs: 10_000,
} as const;

export const MintTokenRequest = z
  .object({
    scope: TokenScope,
    /** For `view` and `control`; never past the session's deadline plus one minute. */
    ttlMs: z
      .number()
      .int()
      .min(TOKEN_TTL.minMs)
      .max(TOKEN_TTL.liveMaxMs)
      .optional(),
    singleUse: z.boolean().default(false),
  })
  .strict()
  .meta({ id: "MintTokenRequest" });
export type MintTokenRequest = z.infer<typeof MintTokenRequest>;

export const SessionToken = z
  .object({
    scope: TokenScope,
    token: z.string(),
    /** `cdp`: the `wss://` connect URL (`ws://` in local mode). `view`/`control`: the viewer page, with the token in the fragment. */
    url: z.string(),
    expiresAt: z.string(),
  })
  .meta({ id: "SessionToken" });
export type SessionToken = z.infer<typeof SessionToken>;
