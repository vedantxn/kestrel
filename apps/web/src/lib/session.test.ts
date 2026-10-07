import { describe, expect, it } from "vitest";
import { SESSION_TTL_S, openSession, sealSession, sessionKey } from "./session";

const key = sessionKey("a".repeat(48));
const session = {
  apiKey: "ksl_" + "x".repeat(43),
  projectId: "prj_01m463crenefbt7jy722qa5fk2",
  admin: false,
};

describe("the session cookie (T-66)", () => {
  it("round-trips, and the key is not readable in the cookie", async () => {
    const token = await sealSession(session, key);
    expect(token).not.toContain(session.apiKey);
    expect(token).not.toContain(
      Buffer.from(session.apiKey).toString("base64url"),
    );
    expect(await openSession(token, key)).toEqual(session);
  });

  it("is refused when tampered with, under another key, or expired", async () => {
    const now = 1_800_000_000;
    const token = await sealSession(session, key, now);
    const parts = token.split(".");
    const ct = parts[3]!;
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(await openSession(parts.join("."), key, now)).toBeNull();
    expect(
      await openSession(token, sessionKey("b".repeat(48)), now),
    ).toBeNull();
    expect(await openSession(token, key, now + SESSION_TTL_S - 1)).toEqual(
      session,
    );
    expect(await openSession(token, key, now + SESSION_TTL_S + 1)).toBeNull();
    expect(await openSession(undefined, key)).toBeNull();
    expect(await openSession("garbage", key)).toBeNull();
  });

  it("needs a long secret", () => {
    expect(() => sessionKey("short")).toThrow(/32 characters/);
  });
});
