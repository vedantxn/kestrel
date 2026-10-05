import { describe, expect, it } from "vitest";
import {
  CAPTCHA_PROVIDERS,
  CaptchaHost,
  CaptchaProviders,
  RuntimeCaptcha,
  SessionCaptcha,
  captchaSet,
} from "./captcha.js";
import { EventBody } from "./events.js";
import { newId } from "./ids.js";
import { Report } from "./node-protocol.js";
import { Session } from "./session.js";

describe("CAPTCHA contracts", () => {
  it("keeps provider sets unique and ordered", () => {
    expect(CaptchaProviders.safeParse(["recaptcha", "turnstile"]).success).toBe(
      true,
    );
    expect(CaptchaProviders.safeParse(["turnstile", "recaptcha"]).success).toBe(
      false,
    );
    expect(CaptchaProviders.safeParse(["recaptcha", "recaptcha"]).success).toBe(
      false,
    );
    expect(CaptchaProviders.safeParse(["captcha-x"]).success).toBe(false);
    expect(captchaSet(["datadome", "recaptcha", "datadome"])).toEqual([
      "recaptcha",
      "datadome",
    ]);
    expect(
      CaptchaProviders.safeParse(captchaSet([...CAPTCHA_PROVIDERS].reverse()))
        .success,
    ).toBe(true);
  });

  it("allows a lowercase hostname only, never a path, query or other text", () => {
    expect(CaptchaHost.safeParse("shop.example.com").success).toBe(true);
    for (const bad of [
      "",
      "Shop.example.com",
      "example.com/login",
      "example.com?q=1",
      "example.com:443",
      "user@example.com",
      "a b",
      "x\u0000",
      "a".repeat(254),
    ])
      expect(CaptchaHost.safeParse(bad).success).toBe(false);
  });

  it("keeps events consistent with the set present", () => {
    const ok = (type: string, data: unknown) =>
      EventBody.safeParse({ type, data }).success;
    expect(
      ok("captcha.detected", {
        provider: "recaptcha",
        host: "example.com",
        present: ["recaptcha"],
      }),
    ).toBe(true);
    expect(
      ok("captcha.detected", {
        provider: "recaptcha",
        host: null,
        present: ["turnstile"],
      }),
    ).toBe(false);
    expect(ok("captcha.cleared", { provider: "recaptcha", present: [] })).toBe(
      true,
    );
    expect(
      ok("captcha.cleared", { provider: "recaptcha", present: ["recaptcha"] }),
    ).toBe(false);
  });

  it("lets nodes report the new events", () => {
    expect(
      Report.safeParse({
        id: "r1",
        at: "2026-10-05T10:00:00.000Z",
        kind: "event",
        sessionId: newId("ses"),
        event: {
          type: "captcha.cleared",
          data: { provider: "hcaptcha", present: [] },
        },
      }).success,
    ).toBe(true);
  });

  it("bounds runtimed's answer and refuses unknown fields", () => {
    const d = { provider: "recaptcha", host: "example.com" };
    expect(
      RuntimeCaptcha.safeParse({ watching: true, detections: [d] }).success,
    ).toBe(true);
    expect(
      RuntimeCaptcha.safeParse({
        watching: true,
        detections: Array.from({ length: 17 }, () => d),
      }).success,
    ).toBe(false);
    expect(
      RuntimeCaptcha.safeParse({
        watching: true,
        detections: [{ ...d, url: "https://example.com/?secret" }],
      }).success,
    ).toBe(false);
    expect(
      RuntimeCaptcha.safeParse({ watching: true, detections: [], extra: 1 })
        .success,
    ).toBe(false);
  });

  it("puts the current CAPTCHA on the session, or null", () => {
    expect(Session.shape.captcha.safeParse(null).success).toBe(true);
    expect(
      SessionCaptcha.safeParse({
        providers: ["turnstile"],
        since: "2026-10-05T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SessionCaptcha.safeParse({
        providers: [],
        since: "2026-10-05T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
