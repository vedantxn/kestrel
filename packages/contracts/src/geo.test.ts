import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  COUNTRY_TIMEZONES,
  CountryCode,
  isTimezone,
  Timezone,
} from "./geo.js";
import { StartRequest } from "./node-protocol.js";
import { ConfigureRequest } from "./runtime-control.js";
import { CreateSessionRequest, SessionOptions } from "./session.js";

describe("country codes", () => {
  it("are exactly the 249 assigned ISO 3166-1 alpha-2 codes", () => {
    expect(COUNTRY_CODES.size).toBe(249);
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
    expect(CountryCode.safeParse("UK").success).toBe(false);
    expect(CountryCode.safeParse("de").success).toBe(false);
  });

  it("every default zone is for a real country and a zone this runtime knows", () => {
    for (const [c, tz] of Object.entries(COUNTRY_TIMEZONES)) {
      expect(COUNTRY_CODES.has(c)).toBe(true);
      expect(isTimezone(tz)).toBe(true);
    }
    // Countries with several zones in wide use get no default.
    for (const c of ["US", "CA", "MX", "BR", "RU", "AU", "ID", "KZ", "CL"])
      expect(COUNTRY_TIMEZONES[c]).toBeUndefined();
  });
});

describe("time zones", () => {
  it.each([
    "Europe/Berlin",
    "America/Argentina/Buenos_Aires",
    "UTC",
    "Etc/GMT+5",
    "Asia/Kolkata",
    "Asia/Calcutta",
  ])("accepts %s", (tz) => expect(Timezone.safeParse(tz).success).toBe(true));

  it.each([
    "Europe/Nowhere",
    "+05:00",
    "GMT+5",
    "europe/berlin",
    "Europe/Berlin\n",
    "../etc/passwd",
    "Europe/Berlin/Extra/More",
    "",
    "a".repeat(80),
  ])("refuses %j", (tz) => expect(Timezone.safeParse(tz).success).toBe(false));

  it("is a session option, carried to the node and to runtimed", () => {
    expect(SessionOptions.parse({ timezone: "Asia/Tokyo" }).timezone).toBe(
      "Asia/Tokyo",
    );
    expect(
      CreateSessionRequest.safeParse({ timezone: "Mars/Olympus" }).success,
    ).toBe(false);
    const start = {
      sessionId: "ses_01h0000000000000000000000a",
      projectId: "prj_01h0000000000000000000000a",
      epoch: 1,
      viewport: { width: 1280, height: 720 },
      network: {},
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      stopOnDisconnect: false,
    };
    expect(
      StartRequest.parse({ ...start, timezone: "Asia/Tokyo" }).timezone,
    ).toBe("Asia/Tokyo");
    expect(StartRequest.safeParse({ ...start, timezone: "nope" }).success).toBe(
      false,
    );
    expect(
      ConfigureRequest.parse({
        sessionProof: "a".repeat(64),
        viewport: { width: 1280, height: 720 },
        timezone: "Asia/Tokyo",
      }).timezone,
    ).toBe("Asia/Tokyo");
  });
});
