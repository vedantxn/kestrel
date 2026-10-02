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
}

export class TokenSigner {
  private constructor(private readonly key: CryptoKey) {}

  static async fromPem(privatePem: string): Promise<TokenSigner> {
    return new TokenSigner(await importPKCS8(privatePem, TOKEN_ALG));
  }

  async mint(i: MintInput): Promise<string> {
    return new SignJWT({ prj: i.projectId, nod: i.nodeId, scope: i.scope })
      .setProtectedHeader({ alg: TOKEN_ALG, typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setSubject(i.sessionId)
      .setIssuedAt(Math.floor(i.nowMs / 1000))
      .setExpirationTime(
        Math.ceil((i.deadlineMs + TIMINGS.tokenGraceMs) / 1000),
      )
      .sign(this.key);
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
    expectedScope: TokenScope = "cdp",
  ): Promise<VerifyResult> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [TOKEN_ALG],
        issuer: TOKEN_ISSUER,
        currentDate: new Date(nowMs),
      });
      const claims = TokenClaims.safeParse(payload);
      if (!claims.success || claims.data.scope !== expectedScope)
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
