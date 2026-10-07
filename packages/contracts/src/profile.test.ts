import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionEvent } from "./events.js";
import { newId } from "./ids.js";
import { Report, StartRequest, StartResponse } from "./node-protocol.js";
import {
  Base64Key32,
  CreateProfileRequest,
  ListProfilesQuery,
  Profile,
} from "./profile.js";
import {
  LaunchRequest,
  RekeyResponse,
  RuntimeHealth,
} from "./runtime-control.js";
import { CreateSessionRequest, SessionOptions } from "./session.js";

const prf = newId("prf");
const ses = newId("ses");
const key = () => randomBytes(32).toString("base64");

describe("profiles (P18)", () => {
  it("ids are prf_", () => {
    expect(prf).toMatch(/^prf_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  });

  it("takes a 32-byte base64 key and nothing else", () => {
    for (let i = 0; i < 50; i++)
      expect(Base64Key32.safeParse(key()).success).toBe(true);
    expect(
      Base64Key32.safeParse(randomBytes(31).toString("base64")).success,
    ).toBe(false);
    expect(
      Base64Key32.safeParse(randomBytes(33).toString("base64")).success,
    ).toBe(false);
    // non-zero padding bits
    expect(Base64Key32.safeParse(`${"A".repeat(42)}B=`).success).toBe(false);
  });

  it("the create request is strict, with a bounded name", () => {
    expect(CreateProfileRequest.parse({})).toEqual({});
    expect(
      CreateProfileRequest.parse({ name: "work", metadata: { a: "b" } }),
    ).toEqual({
      name: "work",
      metadata: { a: "b" },
    });
    expect(CreateProfileRequest.safeParse({ name: "" }).success).toBe(false);
    expect(
      CreateProfileRequest.safeParse({ name: "x".repeat(101) }).success,
    ).toBe(false);
    expect(CreateProfileRequest.safeParse({ name: "a\nb" }).success).toBe(
      false,
    );
    expect(CreateProfileRequest.safeParse({ owner: "x" }).success).toBe(false);
  });

  it("lists with a coerced limit", () => {
    expect(ListProfilesQuery.parse({ limit: "5" }).limit).toBe(5);
    expect(ListProfilesQuery.parse({}).limit).toBe(20);
    expect(ListProfilesQuery.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("describes a profile", () => {
    Profile.parse({
      id: prf,
      name: null,
      metadata: {},
      version: 0,
      bytes: 0,
      savedAt: null,
      savedBySessionId: null,
      chromeMajor: null,
      inUseBy: ses,
      createdAt: "2026-10-07T12:00:00.000Z",
    });
  });
});

describe("the session option", () => {
  it("defaults persist to false and is strict", () => {
    expect(SessionOptions.parse({ profile: { id: prf } }).profile).toEqual({
      id: prf,
      persist: false,
    });
    expect(SessionOptions.parse({}).profile).toBeUndefined();
    expect(
      CreateSessionRequest.parse({ profile: { id: prf, persist: true } })
        .profile,
    ).toEqual({ id: prf, persist: true });
    expect(SessionOptions.safeParse({ profile: { id: ses } }).success).toBe(
      false,
    );
    expect(
      SessionOptions.safeParse({ profile: { id: prf, version: 2 } }).success,
    ).toBe(false);
  });
});

describe("the node protocol", () => {
  const start = {
    sessionId: ses,
    projectId: newId("prj"),
    epoch: 1,
    viewport: { width: 1280, height: 720 },
    network: {},
    timeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    stopOnDisconnect: false,
  };

  it("carries the profile in the start request, strictly", () => {
    const profile = {
      profileId: prf,
      restore: {
        version: 3,
        chromeMajor: 154,
        bytes: 1234,
        sha256: "a".repeat(64),
        key: key(),
      },
      save: { version: 4, key: key(), maxBytes: 64 * 1024 * 1024 },
    };
    expect(StartRequest.parse({ ...start, profile }).profile).toEqual(profile);
    expect(
      StartRequest.parse({ ...start, profile: { profileId: prf } }).profile,
    ).toEqual({ profileId: prf });
    for (const bad of [
      { ...profile, extra: 1 },
      { ...profile, restore: { ...profile.restore, path: "/etc" } },
      { ...profile, save: { ...profile.save, maxBytes: 512 * 1024 * 1024 } },
      { ...profile, restore: { ...profile.restore, sha256: "A".repeat(64) } },
      { ...profile, save: { ...profile.save, key: "short" } },
    ])
      expect(StartRequest.safeParse({ ...start, profile: bad }).success).toBe(
        false,
      );
  });

  it("is refused by a schema from before profiles (strict)", () => {
    const before = StartRequest.omit({ profile: true });
    expect(
      before.safeParse({ ...start, profile: { profileId: prf } }).success,
    ).toBe(false);
  });

  it("answers warm, and failed with the profile code", () => {
    expect(
      StartResponse.parse({
        result: "ready",
        startPath: "warm",
        readyMs: 900,
        deviceScaleFactor: 1,
      }),
    ).toMatchObject({ startPath: "warm" });
    expect(
      StartResponse.parse({
        result: "failed",
        reason: "blob digest",
        code: "profile_unavailable",
      }),
    ).toMatchObject({ code: "profile_unavailable" });
    expect(
      StartResponse.safeParse({ result: "failed", reason: "x", code: "other" })
        .success,
    ).toBe(false);
  });

  it("reports a save once, saved or failed", () => {
    const common = {
      id: "r1",
      at: "2026-10-07T12:00:00.000Z",
      kind: "profile",
      sessionId: ses,
      profileId: prf,
      version: 4,
    };
    expect(
      Report.parse({
        ...common,
        outcome: "saved",
        bytes: 10,
        sha256: "b".repeat(64),
      }),
    ).toMatchObject({ kind: "profile", outcome: "saved" });
    expect(
      Report.parse({ ...common, outcome: "failed", reason: "too_large" }),
    ).toMatchObject({ reason: "too_large" });
    expect(
      Report.safeParse({ ...common, outcome: "failed", reason: "because" })
        .success,
    ).toBe(false);
  });

  it("lets a node report profile.restored but not the API's profile events", () => {
    const report = (type: string, data: object) =>
      Report.safeParse({
        id: "r",
        at: "2026-10-07T12:00:00.000Z",
        kind: "event",
        sessionId: ses,
        event: { type, data },
      }).success;
    expect(
      report("profile.restored", {
        profileId: prf,
        version: 1,
        bytes: 5,
        ms: 12,
      }),
    ).toBe(true);
    expect(
      report("profile.saved", { profileId: prf, version: 1, bytes: 5 }),
    ).toBe(false);
    expect(
      report("profile.save_failed", { profileId: prf, reason: "stale" }),
    ).toBe(false);
  });

  it("parses the profile events", () => {
    SessionEvent.parse({
      id: newId("evt"),
      sessionId: ses,
      at: "2026-10-07T12:00:00.000Z",
      type: "profile.save_failed",
      data: { profileId: prf, reason: "no_report" },
    });
  });
});

describe("runtime control", () => {
  it("has a warm health status, a strict launch request and the guest's clock at rekey", () => {
    expect(
      RuntimeHealth.parse({
        protocolVersion: 1,
        status: "warm",
        chromeReady: false,
        chromeVersion: null,
      }).status,
    ).toBe("warm");
    expect(
      LaunchRequest.safeParse({
        viewport: { width: 1280, height: 720 },
        args: [],
      }).success,
    ).toBe(false);
    expect(RekeyResponse.parse({ ok: true, now: 1 }).now).toBe(1);
    expect(RekeyResponse.parse({ ok: true }).now).toBeUndefined();
  });
});
