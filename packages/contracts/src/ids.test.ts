import { describe, expect, it } from "vitest";
import {
  ID_PREFIXES,
  NodeId,
  SessionId,
  idToUuid,
  newId,
  uuidToId,
  uuidv7,
} from "./ids.js";

describe("ids", () => {
  it("encodes known uuids as Crockford base32 (vectors computed independently in Python)", () => {
    expect(uuidToId("ses", "00000000-0000-0000-0000-000000000000")).toBe(
      "ses_00000000000000000000000000",
    );
    expect(uuidToId("ses", "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(
      "ses_7zzzzzzzzzzzzzzzzzzzzzzzzz",
    );
    expect(uuidToId("ses", "00000000-0000-0000-0000-00000000000a")).toBe(
      "ses_0000000000000000000000000a",
    );
    expect(uuidToId("ses", "01890a5d-ac96-774b-bcce-b302099a8057")).toBe(
      "ses_01h455vb4pex5vsknk084sn02q",
    );
  });

  it("round-trips through the uuid", () => {
    for (let i = 0; i < 200; i++) {
      const id = newId("ses");
      expect(uuidToId("ses", idToUuid(id))).toBe(id);
      expect(SessionId.safeParse(id).success).toBe(true);
    }
  });

  it("is time ordered", () => {
    const a = newId("ses", 1_000_000);
    const b = newId("ses", 2_000_000);
    expect(a < b).toBe(true);
  });

  it("makes version 7 uuids", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("checks the prefix", () => {
    const prj = newId("prj");
    expect(SessionId.safeParse(prj).success).toBe(false);
    expect(prj.startsWith(`${ID_PREFIXES.project}_`)).toBe(true);
  });

  it("rejects malformed ids", () => {
    for (const bad of [
      "",
      "ses_",
      "ses_8zzzzzzzzzzzzzzzzzzzzzzzzz",
      "ses_0000000000000000000000000i",
      "SES_00000000000000000000000000",
    ]) {
      expect(SessionId.safeParse(bad).success).toBe(false);
    }
    expect(() => idToUuid("nonsense")).toThrow();
  });

  it("restricts node ids to names safe in interface and chain names", () => {
    expect(NodeId.safeParse("a").success).toBe(true);
    for (const bad of ["", "A", "a-b", "1a", "a/b", "a".repeat(17)])
      expect(NodeId.safeParse(bad).success).toBe(false);
  });
});
