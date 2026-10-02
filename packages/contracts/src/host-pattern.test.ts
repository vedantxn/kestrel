import { describe, expect, it } from "vitest";
import { matchesHostPattern } from "./host-pattern.js";

describe("matchesHostPattern", () => {
  it("matches exact hostnames case-insensitively, ignoring a trailing dot", () => {
    expect(matchesHostPattern("example.com", "EXAMPLE.com")).toBe(true);
    expect(matchesHostPattern("example.com", "example.com.")).toBe(true);
    expect(matchesHostPattern("example.com", "www.example.com")).toBe(false);
  });

  it("matches wildcard subdomains at any depth but not the apex", () => {
    expect(matchesHostPattern("*.example.com", "a.example.com")).toBe(true);
    expect(matchesHostPattern("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchesHostPattern("*.example.com", "example.com")).toBe(false);
  });

  it("does not match a host that merely ends with the same characters", () => {
    expect(matchesHostPattern("*.example.com", "evilexample.com")).toBe(false);
    expect(matchesHostPattern("*.example.com", "example.com.evil.net")).toBe(
      false,
    );
  });
});
