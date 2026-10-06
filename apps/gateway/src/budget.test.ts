import { describe, expect, it } from "vitest";
import { BufferBudget, sessionShare } from "./budget.js";

describe("the buffer budget (C6, G-03)", () => {
  it("counts bytes globally and per session, and refuses past the global limit", () => {
    const b = new BufferBudget(100, 40);
    expect(b.reserve("a", 30)).toBe(true);
    expect(b.reserve("b", 50)).toBe(true);
    expect(b.reserve("b", 21)).toBe(false); // nothing reserved on a refusal
    expect(b.usedBytes).toBe(80);
    expect(b.sessionBytes("b")).toBe(50);
    b.release("b", 50);
    expect(b.sessionBytes("b")).toBe(0);
    expect(b.usedBytes).toBe(30);
  });

  it("says when a session is over its share, and when it has drained enough to be read again", () => {
    const b = new BufferBudget(100, 40);
    b.reserve("a", 41);
    expect(b.overShare("a")).toBe(true);
    expect(b.canResume("a")).toBe(false);
    b.release("a", 21);
    expect(b.overShare("a")).toBe(false);
    expect(b.canResume("a")).toBe(true);
  });

  it("resumes only at half the share or less", () => {
    const b = new BufferBudget(100, 40);
    b.reserve("a", 21);
    expect(b.overShare("a")).toBe(false);
    expect(b.canResume("a")).toBe(false);
    b.release("a", 1);
    expect(b.canResume("a")).toBe(true);
  });

  it("lists the sessions over their share, the most first", () => {
    const b = new BufferBudget(1000, 100);
    b.reserve("small", 50);
    b.reserve("big", 400);
    b.reserve("bigger", 450);
    expect(b.sessionsOverShare()).toEqual(["bigger", "big"]);
    expect(b.largestSessionBytes).toBe(450);
  });

  it("never lets a release go below zero", () => {
    const b = new BufferBudget(100, 40);
    b.reserve("a", 10);
    b.release("a", 30);
    expect(b.usedBytes).toBe(0);
    expect(b.sessionBytes("a")).toBe(0);
    expect(b.sessionsOverShare()).toEqual([]);
  });
});

describe("a session's share", () => {
  const MiB = 1024 * 1024;
  const base = { globalBytes: 1024 * MiB, defaultBytes: 256 * MiB };

  it("is the budget divided by the node's slots", () => {
    expect(sessionShare({ ...base, slots: 4 })).toBe(256 * MiB);
    expect(sessionShare({ ...base, slots: 6 })).toBe(
      Math.floor((1024 * MiB) / 6),
    );
  });

  it("is the configured value when there is one", () => {
    expect(sessionShare({ ...base, slots: 6, configuredBytes: 64 * MiB })).toBe(
      64 * MiB,
    );
  });

  it("falls back to the contract's default, and is never more than the budget", () => {
    expect(sessionShare(base)).toBe(256 * MiB);
    expect(sessionShare({ ...base, slots: 1 })).toBe(1024 * MiB);
    expect(sessionShare({ ...base, configuredBytes: 4096 * MiB })).toBe(
      1024 * MiB,
    );
  });
});
