import { z } from "zod";

/**
 * CAPTCHA detection (`docs/lld/captcha.md`). `runtimed` watches the browser's page and iframe
 * targets from outside every page and reports CAPTCHAs from known providers; the node agent
 * polls it and turns changes into events; the API keeps the current set on the session.
 *
 * "Present" means a provider's widget or challenge frame is loaded in some page. It is not
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

/** On the session: what is present now, and since when, or null. */
export const SessionCaptcha = z
  .object({
    providers: CaptchaProviders.min(1),
    since: z.iso
      .datetime({ offset: true })
      .describe("When the current, unbroken presence began."),
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
