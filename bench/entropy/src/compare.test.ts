import { describe, expect, it } from "vitest";
import { compare, type SessionObservation } from "./compare.js";

let n = 0;
const fresh = (): string => (++n).toString(16).padStart(32, "0");
function obs(
  label: string,
  over: Partial<SessionObservation> = {},
): SessionObservation {
  const r = () => ({
    math: [Math.random(), Math.random()],
    grv: fresh(),
    uuid: fresh(),
    ecdh: fresh(),
  });
  return {
    label,
    first: r(),
    page: r(),
    skewMs: 3,
    hellos: [
      { random: fresh(), sessionId: fresh(), sni: null, keyShares: [fresh()] },
    ],
    ...over,
  };
}

describe("compare", () => {
  it("passes when every value appears once", () => {
    const r = compare([obs("a"), obs("b"), obs("c")]);
    expect(r.pass).toBe(true);
    expect(
      r.items.find((i) => i.item === "TLS ClientHello random")?.values,
    ).toBe(3);
  });

  it("fails on a value two sessions share, and names them", () => {
    const a = obs("a");
    const b = obs("b", {
      first: { ...obs("x").first, math: [...a.first.math] },
    });
    const r = compare([a, b, obs("c")]);
    expect(r.pass).toBe(false);
    const m = r.items.find((i) => i.item === "first page: Math.random")!;
    expect(m.collisions).toHaveLength(2);
    expect(m.collisions[0]!.sessions).toEqual(["a", "b"]);
  });

  it("fails on a value repeated within one session, and on a session that failed", () => {
    const h = { random: "aa", sessionId: "", sni: null, keyShares: [] };
    expect(compare([obs("a", { hellos: [h, h] }), obs("b")]).pass).toBe(false);
    expect(
      compare([obs("a"), obs("b", { error: "connect failed" })]).pass,
    ).toBe(false);
  });

  it("needs two sessions to say anything", () => {
    expect(compare([obs("a")]).pass).toBe(false);
  });
});
