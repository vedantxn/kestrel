import { describe, expect, it } from "vitest";
import {
  SpentTokens,
  TokenSigner,
  TokenVerifier,
  generateTokenKeys,
} from "./tokens.js";

const keys = await generateTokenKeys();
const signer = await TokenSigner.fromPem(keys.privatePem);
const verifier = await TokenVerifier.fromPem(keys.publicPem);
const now = 1_800_000_000_000;
const base = {
  sessionId: "ses_0000000000000000000000000a",
  projectId: "prj_0000000000000000000000000a",
  nodeId: "a",
  deadlineMs: now + 3_600_000,
  nowMs: now,
};

describe("token lifetimes and scopes (W1)", () => {
  it("defaults to the session deadline plus one minute", async () => {
    const { expMs } = await signer.mintWithExpiry({ ...base, scope: "cdp" });
    expect(expMs).toBe(now + 3_600_000 + 60_000);
  });

  it("honours a shorter TTL but never outlives the deadline", async () => {
    const short = await signer.mintWithExpiry({
      ...base,
      scope: "view",
      ttlMs: 600_000,
    });
    expect(short.expMs).toBe(now + 600_000);
    const long = await signer.mintWithExpiry({
      ...base,
      scope: "view",
      deadlineMs: now + 60_000,
      ttlMs: 3_600_000,
    });
    expect(long.expMs).toBe(now + 120_000);
  });

  it("checks scope: control opens view's door, view does not open CDP", async () => {
    const control = await signer.mint({ ...base, scope: "control" });
    expect((await verifier.verify(control, now, ["view", "control"])).ok).toBe(
      true,
    );
    expect((await verifier.verify(control, now, "cdp")).ok).toBe(false);
    const view = await signer.mint({ ...base, scope: "view" });
    expect((await verifier.verify(view, now)).ok).toBe(false);
  });

  it("marks single-use tokens with a jti", async () => {
    const t = await signer.mint({
      ...base,
      scope: "view",
      jti: "abcdef0123456789abcd",
    });
    const v = await verifier.verify(t, now, "view");
    expect(v.ok && v.claims.once && v.claims.jti).toBe("abcdef0123456789abcd");
  });

  it("refuses an expired live token", async () => {
    const t = await signer.mint({ ...base, scope: "view", ttlMs: 10_000 });
    const v = await verifier.verify(t, now + 11_000, "view");
    expect(v).toEqual({ ok: false, reason: "expired" });
  });
});

describe("SpentTokens", () => {
  it("spends once, forgets after expiry, and refuses when full", () => {
    const s = new SpentTokens(2);
    expect(s.spend("a", 10, 0)).toBe(true);
    expect(s.spend("a", 10, 0)).toBe(false);
    expect(s.spend("b", 20, 0)).toBe(true);
    expect(s.spend("c", 20, 5_000)).toBe(false); // full, and nothing has expired
    expect(s.spend("c", 20, 11_000)).toBe(true); // "a" expired and was pruned
  });
});
