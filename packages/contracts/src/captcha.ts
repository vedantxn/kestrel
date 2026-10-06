import { z } from "zod";

/**
 * CAPTCHA detection and solving (`docs/lld/captcha.md`). `runtimed` watches the browser's pages
 * and frames and reports CAPTCHAs from known providers; the node agent polls it and turns
 * changes into events; the API keeps the current set on the session. A session created with
 * `captcha.solve` also has the CAPTCHAs the platform can solve sent to the deployment's solver
 * service, and the token put into the page.
 *
 * "Present" means a provider's widget or challenge is loaded in some page. It is not
 * "unsolved": a solved checkbox keeps its frame until the page moves on.
 */
export const CAPTCHA_PROVIDERS = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  /** Cloudflare's full-page challenge ("Just a moment..."). */
  "cloudflare_challenge",
  "arkose",
  "datadome",
  /** HUMAN (PerimeterX) press-and-hold, in the page. */
  "perimeterx",
  /** GeeTest v3 or v4, in the page. */
  "geetest",
  /** AWS WAF's CAPTCHA interstitial. */
  "aws_waf",
] as const;
export const CaptchaProvider = z
  .enum(CAPTCHA_PROVIDERS)
  .meta({ id: "CaptchaProvider" });
export type CaptchaProvider = z.infer<typeof CaptchaProvider>;

export const CAPTCHA_LIMITS = {
  /** Detections in one answer from `runtimed`. */
  maxDetections: 16,
  hostMaxLength: 253,
} as const;

/** The hostname of the top-level page a CAPTCHA is on: never a path, query, site key or title (T-51). */
export const CaptchaHost = z
  .string()
  .min(1)
  .max(CAPTCHA_LIMITS.hostMaxLength)
  .regex(/^[a-z0-9.-]+$/, "a lowercase hostname");

const order = (p: CaptchaProvider) => CAPTCHA_PROVIDERS.indexOf(p);

/** A set of providers: unique, in `CAPTCHA_PROVIDERS` order. */
export const CaptchaProviders = z
  .array(CaptchaProvider)
  .max(CAPTCHA_PROVIDERS.length)
  .refine(
    (ps) => ps.every((p, i) => i === 0 || order(ps[i - 1]!) < order(p)),
    "unique providers, in the order of CAPTCHA_PROVIDERS",
  );

/** Sort and de-duplicate into a `CaptchaProviders` set. */
export function captchaSet(ps: Iterable<CaptchaProvider>): CaptchaProvider[] {
  return [...new Set(ps)].sort((a, b) => order(a) - order(b));
}

/** Why a solve did not put a token in the page. */
export const CAPTCHA_SOLVE_FAILURES = [
  /** The platform does not solve this provider: hand it to a person. */
  "unsupported",
  /** The site key or page could not be read. */
  "no_details",
  /** The solver service refused or could not solve it (bad key, no balance, unsolvable). */
  "solver_error",
  /** The solver service could not be reached, or answered nonsense. */
  "solver_unreachable",
  "timeout",
  /** The widget, or its response field, was gone when the token came back. */
  "inject_failed",
  /** The session has used its solves (`CAPTCHA_SOLVE_LIMITS.maxSolvesPerSession`). */
  "budget",
  /** The node has no solver for this session (its agent restarted since the session began). */
  "no_solver",
  /** The browser's `runtimed` predates solving. */
  "runtime_unsupported",
] as const;
export const CaptchaSolveFailure = z
  .enum(CAPTCHA_SOLVE_FAILURES)
  .meta({ id: "CaptchaSolveFailure" });
export type CaptchaSolveFailure = z.infer<typeof CaptchaSolveFailure>;

/** On the session, beside what is present: the latest solve of something still present. */
export const CaptchaSolveState = z
  .object({
    provider: CaptchaProvider,
    status: z.enum(["solving", "solved", "failed"]),
    at: z.iso.datetime({ offset: true }),
    reason: CaptchaSolveFailure.nullable(),
  })
  .meta({
    id: "CaptchaSolveState",
    description:
      "`solved` means a token was put into the page (and its callback called, when one was found); the site may still refuse it. `failed`: hand the CAPTCHA to a person.",
  });
export type CaptchaSolveState = z.infer<typeof CaptchaSolveState>;

/** On the session: what is present now, and since when, or null. */
export const SessionCaptcha = z
  .object({
    providers: CaptchaProviders.min(1),
    since: z.iso
      .datetime({ offset: true })
      .describe("When the current, unbroken presence began."),
    solve: CaptchaSolveState.nullable()
      .default(null)
      .describe(
        "Sessions created with `captcha.solve`: the latest solve of a CAPTCHA still present.",
      ),
  })
  .meta({
    id: "SessionCaptcha",
    description:
      "A CAPTCHA from a known provider is showing on a page. It may already be solved: a solved checkbox stays until the page moves on.",
  });
export type SessionCaptcha = z.infer<typeof SessionCaptcha>;

/** `captcha.detected`: `provider` appeared; `present` is everything present after it. */
export const CaptchaDetectedData = z
  .object({
    provider: CaptchaProvider,
    host: CaptchaHost.nullable(),
    present: CaptchaProviders.min(1),
  })
  .refine((d) => d.present.includes(d.provider), {
    message: "present must include provider",
    path: ["present"],
  });

/** `captcha.cleared`: `provider` is gone; `present` is what remains. */
export const CaptchaClearedData = z
  .object({
    provider: CaptchaProvider,
    present: CaptchaProviders,
  })
  .refine((d) => !d.present.includes(d.provider), {
    message: "present must not include provider",
    path: ["present"],
  });

/**
 * C5 `GET /captcha`, answered by `runtimed` once configured. Hostile input: the agent
 * validates it and bounds its size. `watching: false` means the state is unknown.
 */
export const RuntimeCaptcha = z.strictObject({
  watching: z.boolean(),
  detections: z
    .array(
      z.strictObject({
        provider: CaptchaProvider,
        host: CaptchaHost.nullable(),
      }),
    )
    .max(CAPTCHA_LIMITS.maxDetections),
});
export type RuntimeCaptcha = z.infer<typeof RuntimeCaptcha>;

// --- Solving: opt-in per session, with the deployment's own solver service -------------------

/**
 * The providers the platform can solve: a token from a solver service, put into the widget's
 * response field and passed to its callback. The others are reported and left to a person.
 */
export const SOLVABLE_CAPTCHA_PROVIDERS = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
] as const satisfies readonly CaptchaProvider[];
export const SolvableCaptchaProvider = z.enum(SOLVABLE_CAPTCHA_PROVIDERS);
export type SolvableCaptchaProvider = z.infer<typeof SolvableCaptchaProvider>;

export function isSolvable(p: CaptchaProvider): p is SolvableCaptchaProvider {
  return (SOLVABLE_CAPTCHA_PROVIDERS as readonly string[]).includes(p);
}

export const CAPTCHA_SOLVE_LIMITS = {
  /** Solves one session may ask for: the operator pays for each one (T-55). */
  maxSolvesPerSession: 10,
  /** A whole solve, from asking the service to the token in the page. */
  solveTimeoutMs: 180_000,
  tokenMaxLength: 16_384,
  siteKeyMaxLength: 128,
  pageUrlMaxLength: 2048,
  /** Challenges in one answer from `runtimed`. */
  maxChallenges: 8,
} as const;

/** A session option: off unless asked for. */
export const CaptchaOptions = z
  .strictObject({
    solve: z
      .boolean()
      .default(false)
      .describe(
        "Send reCAPTCHA, hCaptcha and Turnstile widgets that show to the deployment's CAPTCHA solver service and put the token into the page. Refused when the deployment has no solver. The page's URL (without query or fragment) and the widget's site key go to that third party, and the page can tell its callback was called by something other than the widget.",
      ),
  })
  .meta({ id: "CaptchaOptions" });
export type CaptchaOptions = z.infer<typeof CaptchaOptions>;

/** `captcha.solving`: a solver service was asked. */
export const CaptchaSolvingData = z.object({
  provider: SolvableCaptchaProvider,
  host: CaptchaHost.nullable(),
});

/** `captcha.solved`: the token is in the page. */
export const CaptchaSolvedData = z.object({
  provider: SolvableCaptchaProvider,
  host: CaptchaHost.nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Whether the widget's callback was found and called (otherwise only the field was set). */
  callback: z.boolean(),
});

/** `captcha.failed`: no token was put in; a person is the fallback. */
export const CaptchaFailedData = z.object({
  provider: CaptchaProvider,
  host: CaptchaHost.nullable(),
  reason: CaptchaSolveFailure,
});

/** A site key as widgets use them: letters, digits, `-` and `_`. */
export const CaptchaSiteKey = z
  .string()
  .min(8)
  .max(CAPTCHA_SOLVE_LIMITS.siteKeyMaxLength)
  .regex(/^[A-Za-z0-9_-]+$/, "a site key");

/** A token from a solver service: hostile input, so a plain bounded charset (T-56). */
export const CaptchaToken = z
  .string()
  .min(1)
  .max(CAPTCHA_SOLVE_LIMITS.tokenMaxLength)
  .regex(/^[A-Za-z0-9._:+/=-]+$/, "a token");

/**
 * The solver services a deployment can use (`docs/lld/captcha.md`, "Solver services"). All speak
 * the `createTask` / `getTaskResult` protocol; `custom` is any service that speaks it with
 * Anti-Captcha's task names, at a URL the operator gives.
 */
export const CAPTCHA_SOLVER_SERVICES = [
  "capsolver",
  "2captcha",
  "anticaptcha",
  "custom",
] as const;
export const CaptchaSolverService = z.enum(CAPTCHA_SOLVER_SERVICES);
export type CaptchaSolverService = z.infer<typeof CaptchaSolverService>;

/**
 * Internal (C4): the deployment's solver, sent to the node in a start that asked for solving.
 * The key is a secret: never stored by the API or the node, logged or returned (T-54).
 */
export const CaptchaSolverConfig = z
  .strictObject({
    service: CaptchaSolverService,
    /** The service's API base: the operator's choice, required for `custom`. */
    url: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
    apiKey: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/, "printable ASCII"),
  })
  .refine((c) => c.service !== "custom" || c.url !== undefined, {
    message: "a custom solver service needs a url",
    path: ["url"],
  });
export type CaptchaSolverConfig = z.infer<typeof CaptchaSolverConfig>;

/** runtimed's handle for a challenge. */
export const CaptchaChallengeId = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * C5 `GET /captcha/challenges`: what a solver needs, answered only for a session configured to
 * solve. Hostile input (a compromised `runtimed` chooses it): strict and bounded; the agent also
 * checks the URL itself before anything goes to the solver.
 */
export const RuntimeCaptchaChallenges = z.strictObject({
  challenges: z
    .array(
      z.strictObject({
        id: CaptchaChallengeId,
        provider: SolvableCaptchaProvider,
        siteKey: CaptchaSiteKey,
        /** The page's URL: origin and path, no query or fragment. */
        pageUrl: z.string().min(1).max(CAPTCHA_SOLVE_LIMITS.pageUrlMaxLength),
        /** The page's hostname, as detection reports it. */
        host: CaptchaHost.nullable(),
        invisible: z.boolean(),
        /** Turnstile's `data-action` and `data-cdata`, when the widget has them. */
        action: z
          .string()
          .max(64)
          .regex(/^[A-Za-z0-9_-]*$/)
          .optional(),
        cdata: z
          .string()
          .max(255)
          .regex(/^[A-Za-z0-9_-]*$/)
          .optional(),
      }),
    )
    .max(CAPTCHA_SOLVE_LIMITS.maxChallenges),
});
export type RuntimeCaptchaChallenges = z.infer<typeof RuntimeCaptchaChallenges>;
export type RuntimeCaptchaChallenge =
  RuntimeCaptchaChallenges["challenges"][number];

/** C5 `POST /captcha/inject`. */
export const CaptchaInjectRequest = z.strictObject({
  id: CaptchaChallengeId,
  token: CaptchaToken,
});
export type CaptchaInjectRequest = z.infer<typeof CaptchaInjectRequest>;

export const RuntimeCaptchaInject = z.strictObject({
  /** `gone`: no such challenge any more; `no_field`: the widget had no response field to fill. */
  result: z.enum(["injected", "gone", "no_field"]),
  callback: z.boolean(),
});
export type RuntimeCaptchaInject = z.infer<typeof RuntimeCaptchaInject>;
