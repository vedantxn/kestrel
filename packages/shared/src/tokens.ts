import {
  TOKEN_ALG,
  TOKEN_ISSUER,
  TIMINGS,
  TokenClaims,
  type TokenScope,
} from "@kestrel/contracts";
import {
  SignJWT,
  errors,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type CryptoKey,
} from "jose";

/**
 * C3, C8, C9. The API signs with the private key; a gateway verifies with the public key
 * alone, so it works with the API down and cannot mint. Ed25519 (`EdDSA`).
 */
export async function generateTokenKeys(): Promise<{
  privatePem: string;
  publicPem: string;
}> {
  const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALG, {
    crv: "Ed25519",
    extractable: true,
  });
  return {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
}

export interface MintInput {
  sessionId: string;
  projectId: string;
  nodeId: string;
  scope: TokenScope;
  /** The session's absolute deadline, epoch ms. The token outlives it by one minute (C8). */
  deadlineMs: number;
  nowMs: number;
  /** A shorter lifetime (W1); the token still never outlives the deadline plus the grace. */
  ttlMs?: number;
  /** A single-use token's id; the gateway refuses it a second time. */
  jti?: string;
}

export class TokenSigner {
  private constructor(private readonly key: CryptoKey) {}

  static async fromPem(privatePem: string): Promise<TokenSigner> {
    return new TokenSigner(await importPKCS8(privatePem, TOKEN_ALG));
  }

  async mint(i: MintInput): Promise<string> {
    return (await this.mintWithExpiry(i)).token;
  }

  /** As `mint`, also returning when the token expires (epoch ms, whole seconds). */
  async mintWithExpiry(
    i: MintInput,
  ): Promise<{ token: string; expMs: number }> {
    const latest = i.deadlineMs + TIMINGS.tokenGraceMs;
    const until =
      i.ttlMs === undefined ? latest : Math.min(latest, i.nowMs + i.ttlMs);
    const exp = Math.ceil(until / 1000);
    const token = await new SignJWT({
      prj: i.projectId,
      nod: i.nodeId,
      scope: i.scope,
      ...(i.jti ? { jti: i.jti, once: true } : {}),
    })
      .setProtectedHeader({ alg: TOKEN_ALG, typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setSubject(i.sessionId)
      .setIssuedAt(Math.floor(i.nowMs / 1000))
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expMs: exp * 1000 };
  }
}

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: "expired" | "invalid" };

export class TokenVerifier {
  private constructor(private readonly key: CryptoKey) {}

  static async fromPem(publicPem: string): Promise<TokenVerifier> {
    return new TokenVerifier(await importSPKI(publicPem, TOKEN_ALG));
  }

  async verify(
    token: string,
    nowMs: number,
    expectedScope: TokenScope | readonly TokenScope[] = "cdp",
  ): Promise<VerifyResult> {
    const scopes: readonly TokenScope[] =
      typeof expectedScope === "string" ? [expectedScope] : expectedScope;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [TOKEN_ALG],
        issuer: TOKEN_ISSUER,
        currentDate: new Date(nowMs),
      });
      const claims = TokenClaims.safeParse(payload);
      if (!claims.success || !scopes.includes(claims.data.scope))
        return { ok: false, reason: "invalid" };
      return { ok: true, claims: claims.data };
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof errors.JWTExpired ? "expired" : "invalid",
      };
    }
  }
}

/**
 * W1. Remembers spent single-use tokens until they expire. One gateway serves one node and a
 * token names its node, so a per-process set is enough; a restart forgets it, which is why
 * single-use tokens are short-lived (TOKEN_TTL.singleUseMaxMs).
 */
export class SpentTokens {
  private spent = new Map<string, number>();
  constructor(private readonly max = 100_000) {}

  /** True the first time a `jti` is seen; false if it was already spent (or the set is full). */
  spend(jti: string, expSeconds: number, nowMs: number): boolean {
    if (this.spent.size >= this.max) this.prune(nowMs);
    if (this.spent.has(jti)) return false;
    if (this.spent.size >= this.max) return false; // refuse rather than forget
    this.spent.set(jti, expSeconds * 1000);
    return true;
  }

  prune(nowMs: number): void {
    for (const [k, exp] of this.spent) if (exp < nowMs) this.spent.delete(k);
  }

  get size(): number {
    return this.spent.size;
  }
}
