import { describe, expect, it } from "vitest";
import {
  CAPTCHA_PROVIDERS,
  CaptchaHost,
  CaptchaInjectRequest,
  CaptchaProviders,
  CaptchaToken,
  RuntimeCaptcha,
  RuntimeCaptchaChallenges,
  RuntimeCaptchaInject,
  SOLVABLE_CAPTCHA_PROVIDERS,
  SessionCaptcha,
  captchaSet,
  isSolvable,
} from "./captcha.js";
import { EventBody } from "./events.js";
import { newId } from "./ids.js";
import { Report, StartRequest } from "./node-protocol.js";
import { ConfigureRequest } from "./runtime-control.js";
import { CreateSessionRequest, Session, SessionOptions } from "./session.js";

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

  it("reads a field stored before solving existed, with no solve", () => {
    expect(
      SessionCaptcha.parse({
        providers: ["recaptcha"],
        since: "2026-10-05T10:00:00.000Z",
      }).solve,
    ).toBeNull();
    expect(
      SessionCaptcha.safeParse({
        providers: ["recaptcha"],
        since: "2026-10-05T10:00:00.000Z",
        solve: {
          provider: "recaptcha",
          status: "failed",
          at: "2026-10-05T10:00:01.000Z",
          reason: "solver_error",
        },
      }).success,
    ).toBe(true);
  });
});

describe("CAPTCHA solving contracts", () => {
  it("is off unless a session asks for it, and refuses unknown options", () => {
    expect(SessionOptions.parse({}).captcha).toEqual({ solve: false });
    expect(SessionOptions.parse({ captcha: {} }).captcha).toEqual({
      solve: false,
    });
    expect(
      CreateSessionRequest.safeParse({ captcha: { solve: true } }).success,
    ).toBe(true);
    expect(
      CreateSessionRequest.safeParse({
        captcha: { solve: true, apiKey: "k" },
      }).success,
    ).toBe(false);
  });

  it("solves only the three widget providers", () => {
    expect([...SOLVABLE_CAPTCHA_PROVIDERS]).toEqual([
      "recaptcha",
      "hcaptcha",
      "turnstile",
    ]);
    for (const p of CAPTCHA_PROVIDERS)
      expect(isSolvable(p)).toBe(
        (SOLVABLE_CAPTCHA_PROVIDERS as readonly string[]).includes(p),
      );
  });

  it("lets nodes report solving events, which carry no site key, URL or token", () => {
    const report = (event: unknown) =>
      Report.safeParse({
        id: "r1",
        at: "2026-10-05T10:00:00.000Z",
        kind: "event",
        sessionId: newId("ses"),
        event,
      }).success;
    expect(
      report({
        type: "captcha.solving",
        data: { provider: "turnstile", host: "example.com" },
      }),
    ).toBe(true);
    expect(
      report({
        type: "captcha.solved",
        data: {
          provider: "hcaptcha",
          host: null,
          durationMs: 1234,
          callback: true,
        },
      }),
    ).toBe(true);
    expect(
      report({
        type: "captcha.failed",
        data: {
          provider: "geetest",
          host: "example.com",
          reason: "unsupported",
        },
      }),
    ).toBe(true);
    // A solving event for a provider the platform does not solve is refused.
    expect(
      report({
        type: "captcha.solving",
        data: { provider: "arkose", host: null },
      }),
    ).toBe(false);
    expect(
      report({
        type: "captcha.failed",
        data: { provider: "recaptcha", host: null, reason: "because" },
      }),
    ).toBe(false);
    // Unknown fields are stripped by the event schema, never stored.
    const parsed = EventBody.parse({
      type: "captcha.solved",
      data: {
        provider: "recaptcha",
        host: null,
        durationMs: 1,
        callback: false,
        token: "03AF-secret",
        siteKey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|6LeIx/);
  });

  it("takes the solver only in a strict start request", () => {
    const base = {
      sessionId: newId("ses"),
      projectId: newId("prj"),
      epoch: 1,
      viewport: { width: 1280, height: 720 },
      network: {},
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      stopOnDisconnect: false,
    };
    const solver = { service: "2captcha", apiKey: "abc123" };
    expect(
      StartRequest.safeParse({ ...base, captcha: { solver } }).success,
    ).toBe(true);
    expect(
      StartRequest.safeParse({
        ...base,
        captcha: { solver: { ...solver, url: "http://127.0.0.1:7390" } },
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...solver, service: "acme" },
      { ...solver, apiKey: "" },
      { ...solver, apiKey: "has space" },
      { ...solver, url: "file:///etc/passwd" },
      { ...solver, extra: 1 },
    ])
      expect(
        StartRequest.safeParse({ ...base, captcha: { solver: bad } }).success,
      ).toBe(false);
    expect(StartRequest.safeParse({ ...base, captcha: {} }).success).toBe(
      false,
    );
  });

  it("bounds what runtimed says a solver needs", () => {
    const c = {
      id: "0123456789abcdef",
      provider: "recaptcha",
      siteKey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
      pageUrl: "https://example.com/login",
      host: "example.com",
      invisible: false,
    };
    const ok = (v: unknown) => RuntimeCaptchaChallenges.safeParse(v).success;
    expect(ok({ challenges: [c] })).toBe(true);
    expect(
      ok({ challenges: [{ ...c, action: "login", cdata: "abc-1_2" }] }),
    ).toBe(true);
    expect(ok({ challenges: Array.from({ length: 9 }, () => c) })).toBe(false);
    for (const bad of [
      { ...c, provider: "geetest" },
      { ...c, siteKey: "<script>" },
      { ...c, id: "xyz" },
      { ...c, pageUrl: "x".repeat(2049) },
      { ...c, action: "a b" },
      { ...c, cookie: "s=1" },
    ])
      expect(ok({ challenges: [bad] })).toBe(false);
  });

  it("accepts tokens as the providers issue them, and nothing that could break out", () => {
    for (const t of [
      "03AFcWeA6x-_abc",
      "P1_eyJ0eXAiOiJKV1Qi.eyJ.x-y_z",
      "0.zrSnRHO7h0HwSjSCU8oyzbjEtD8p.d62306d4ee00c77dda697f959ebbd7bd97",
      "XXXX.DUMMY.TOKEN.XXXX",
      "10000000-aaaa-bbbb-cccc-000000000001",
    ])
      expect(CaptchaToken.safeParse(t).success).toBe(true);
    for (const t of [
      "",
      'a"b',
      "a'b",
      "a<b",
      "a\nb",
      "a b",
      "a\\b",
      "x".repeat(16_385),
    ])
      expect(CaptchaToken.safeParse(t).success).toBe(false);
    expect(
      CaptchaInjectRequest.safeParse({ id: "0123456789abcdef", token: "a.b" })
        .success,
    ).toBe(true);
    expect(
      RuntimeCaptchaInject.safeParse({ result: "injected", callback: true })
        .success,
    ).toBe(true);
    expect(
      RuntimeCaptchaInject.safeParse({ result: "maybe", callback: true })
        .success,
    ).toBe(false);
  });

  it("tells runtimed to answer for solving only when asked", () => {
    const proof = "a".repeat(64);
    expect(
      ConfigureRequest.parse({
        sessionProof: proof,
        viewport: { width: 1280, height: 720 },
      }).captchaSolve,
    ).toBe(false);
  });
});
