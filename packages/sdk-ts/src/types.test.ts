import * as C from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as S from "./types.js";

/*
 * The SDK's hand-written types against the contract's zod schemas. The checks are types, so
 * `npm run build` (tsc) is what fails on drift; the runtime tests below cover the constants.
 *
 * "Same shape" means each side is assignable to the other and both have the same keys. Ids
 * are branded strings in the contracts and plain strings here, so brands are removed first.
 */
type Unbrand<T> = T extends z.core.$brand
  ? string
  : T extends readonly (infer U)[]
    ? Unbrand<U>[]
    : T extends object
      ? { [K in keyof T]: Unbrand<T[K]> }
      : T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = Mutual<keyof A, keyof B>;
type SameShape<A, B> =
  Mutual<Unbrand<A>, B> extends true ? SameKeys<A, B> : false;

const ok = <T extends true>() => true as T;

ok<SameShape<C.SessionStatus, S.SessionStatus>>();
ok<SameShape<C.EndReason, S.EndReason>>();
ok<SameShape<C.EgressDenyReason, S.EgressDenyReason>>();
ok<SameShape<C.Viewport, S.Viewport>>();
ok<SameShape<C.NetworkPolicy, S.NetworkPolicy>>();
ok<SameShape<C.SessionOptions, S.SessionOptions>>();
ok<SameShape<C.SessionProxy, S.SessionProxy>>();
ok<SameShape<C.CaptchaProvider, S.CaptchaProvider>>();
ok<SameShape<C.SessionCaptcha, S.SessionCaptcha>>();
ok<SameShape<C.CaptchaSolveState, S.CaptchaSolveState>>();
ok<SameShape<C.CaptchaSolveFailure, S.CaptchaSolveFailure>>();
ok<SameShape<C.CaptchaOptions, S.CaptchaOptions>>();
ok<SameShape<C.SessionProfile, S.SessionProfile>>();
ok<SameShape<C.ProfileSaveFailure, S.ProfileSaveFailure>>();
ok<SameShape<C.Profile, S.Profile>>();
ok<SameShape<C.CreateProfileRequest, S.CreateProfileRequest>>();
ok<SameShape<z.input<typeof C.ProxyConfig>, S.ProxyConfig>>();
ok<SameShape<z.input<typeof C.CreateSessionRequest>, S.CreateSessionRequest>>();
ok<SameShape<C.Session, S.Session>>();
ok<SameShape<C.Session["usage"], S.Session["usage"]>>();
// The queries' `limit` is coerced from a string, so its input type is `unknown`: compare
// the parsed form, with every field optional as a caller sees it.
ok<SameShape<Partial<C.ListSessionsQuery>, S.ListSessionsQuery>>();
ok<SameShape<Partial<z.output<typeof C.ListEventsQuery>>, S.ListEventsQuery>>();
ok<SameShape<C.ListSessionsResponse, S.Page<S.Session>>>();
ok<SameShape<C.ListEventsResponse, S.Page<S.SessionEvent>>>();
ok<SameShape<C.EventBody, S.EventBody>>();
ok<SameShape<C.EventBody["type"], S.EventBody["type"]>>();
ok<SameShape<C.SessionEvent, S.SessionEvent>>();
ok<SameShape<C.ApiError, S.ErrorBody>>();
ok<SameShape<C.TokenScope, S.TokenScope>>();
ok<SameShape<z.input<typeof C.MintTokenRequest>, S.MintTokenRequest>>();
ok<SameShape<C.SessionToken, S.SessionToken>>();
ok<SameShape<z.input<typeof C.ComputerRequest>, S.ComputerAction>>();
ok<SameShape<C.ComputerRequest["action"], S.ComputerAction["action"]>>();
ok<SameShape<C.ComputerResponse, S.ComputerResponse>>();
// Each action on its own too, since keys that only some variants have are not in `keyof`.
type ComputerIn = z.input<typeof C.ComputerRequest>;
type SameAction<A extends S.ComputerAction["action"]> = SameShape<
  Extract<ComputerIn, { action: A }>,
  Extract<S.ComputerAction, { action: A }>
>;
ok<SameAction<"screenshot">>();
ok<SameAction<"click">>();
ok<SameAction<"move">>();
ok<SameAction<"scroll">>();
ok<SameAction<"type">>();
ok<SameAction<"key">>();

describe("SDK types", () => {
  it("lists the same terminal statuses as the contracts", () => {
    expect([...S.TERMINAL_STATUSES].sort()).toEqual(
      [...C.TERMINAL_STATUSES].sort(),
    );
  });

  it("accepts a session the contract schema produces", () => {
    const parsed: S.Session = C.Session.parse({
      id: "ses_01k6e4m9t8f2xq3w5y7z9a1b2c",
      status: "ready",
      endReason: null,
      createdAt: "2026-10-03T10:00:00.000Z",
      readyAt: null,
      endedAt: null,
      connectUrl: null,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      options: C.SessionOptions.parse({}),
      nodeId: "a",
      startPath: "hot",
      usage: { browserSeconds: 0, egressBytesUp: 0, egressBytesDown: 0 },
      captcha: null,
    });
    expect(parsed.options.timeout).toBe(C.LIMITS.defaultSessionTimeoutMs);
  });
});
