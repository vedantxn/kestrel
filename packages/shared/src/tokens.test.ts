import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { newId } from "@kestrel/contracts";
import { TokenSigner, TokenVerifier, generateTokenKeys } from "./tokens.js";

const sessionId = newId("ses");
const projectId = newId("prj");
const now = Date.parse("2026-10-02T12:00:00Z");
let signer: TokenSigner;
let verifier: TokenVerifier;

beforeAll(async () => {
  const keys = await generateTokenKeys();
  signer = await TokenSigner.fromPem(keys.privatePem);
  verifier = await TokenVerifier.fromPem(keys.publicPem);
});

const mint = (over: Partial<Parameters<TokenSigner["mint"]>[0]> = {}) =>
  signer.mint({
    sessionId,
    projectId,
    nodeId: "a",
    scope: "cdp",
    deadlineMs: now + 60_000,
    nowMs: now,
    ...over,
  });

describe("tokens", () => {
  it("round-trips the claims", async () => {
    const r = await verifier.verify(await mint(), now);
    expect(r.ok && r.claims).toMatchObject({
      iss: "kestrel",
      sub: sessionId,
      prj: projectId,
      nod: "a",
      scope: "cdp",
    });
  });

  it("expires one minute after the session deadline, not before", async () => {
    const t = await mint({ deadlineMs: now + 60_000 });
    expect((await verifier.verify(t, now + 60_000 + 59_000)).ok).toBe(true);
    const late = await verifier.verify(t, now + 60_000 + 61_000);
    expect(late).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token signed by another key", async () => {
    const other = await generateTokenKeys();
    const evil = await TokenSigner.fromPem(other.privatePem);
    const t = await evil.mint({
      sessionId,
      projectId,
      nodeId: "a",
      scope: "cdp",
      deadlineMs: now + 1000,
      nowMs: now,
    });
    expect(await verifier.verify(t, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses the wrong scope and garbage", async () => {
    expect(await verifier.verify(await mint({ scope: "view" }), now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await verifier.verify("not.a.jwt", now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await verifier.verify("", now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses an unsigned token and one using a different algorithm", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const es = await new SignJWT({ prj: projectId, nod: "a", scope: "cdp" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("kestrel")
      .setSubject(sessionId)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + 600)
      .sign(privateKey);
    expect(await verifier.verify(es, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "kestrel", sub: sessionId, prj: projectId, nod: "a", scope: "cdp", iat: 1, exp: 9999999999 })).toString("base64url")}.`;
    expect(await verifier.verify(none, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses claims that do not fit the schema", async () => {
    const t = await mint({ nodeId: "NOT A NODE" });
    expect(await verifier.verify(t, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
