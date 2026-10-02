import { z } from "zod";
import { ProjectId, NodeId, SessionId } from "./ids.js";

/**
 * C3. Tokens and the session proof.
 *
 * The API holds the Ed25519 private key and signs; gateways hold only the public key, so a
 * gateway can verify with the API down and can never mint (C9). A token names one session,
 * project and node, has a scope, and expires one minute after the session's own deadline (C8).
 * Revocation in v1 is removing the session's route; tokens are never extended or rotated.
 */
export const TOKEN_ALG = "EdDSA";
export const TOKEN_ISSUER = "kestrel";

/** `view` and `control` are reserved for the live-view plan; v1 mints and accepts `cdp` only. */
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
