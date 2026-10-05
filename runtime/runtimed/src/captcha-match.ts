import {
  CAPTCHA_LIMITS,
  CaptchaHost,
  captchaSet,
  type CaptchaProvider,
} from "@kestrel/contracts";

/**
 * Which known CAPTCHAs the browser's targets show (`docs/lld/captcha.md`, "What is matched").
 * A pure function over what `Target.setDiscoverTargets` reports: page and iframe targets with
 * their URL, title and parent. The URLs are the page's own (hostile) data: only https, hosts
 * matched exactly or as a dot-separated suffix, and nothing of a URL leaves here but the
 * top-level page's hostname (T-51).
 */
export interface TargetLite {
  type: string;
  url: string;
  title: string;
  parentId?: string | undefined;
}

export interface Detection {
  provider: CaptchaProvider;
  /** The hostname of the page it is on, or null. */
  host: string | null;
}

/** Longer URLs and titles match nothing. */
export const MAX_TARGET_STRING = 2048;
const MAX_PARENT_HOPS = 8;
export const CLOUDFLARE_CHALLENGE_TITLE = "Just a moment...";

const hostIs = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

function parse(url: string): URL | null {
  if (url.length > MAX_TARGET_STRING) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** The provider an iframe's URL belongs to, if it is a visible widget or challenge. */
export function matchFrame(url: string): CaptchaProvider | null {
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname;
  if (
    (host === "www.google.com" || host === "www.recaptcha.net") &&
    /^\/recaptcha\/(api2|enterprise)\/anchor$/.test(u.pathname)
  )
    // The anchor is the checkbox; `size=invisible` is score-only and shows nothing.
    return u.searchParams.get("size") === "invisible" ? null : "recaptcha";
  if (
    hostIs(host, "hcaptcha.com") &&
    /^\/captcha\/v1\/[^/]+\/static\/hcaptcha\.html$/.test(u.pathname)
  ) {
    // The checkbox frame; the challenge frame is created hidden at load, and invisible widgets
    // say `checkbox-invisible`.
    const frame = new URLSearchParams(u.hash.slice(1)).get("frame");
    return frame === "checkbox" ? "hcaptcha" : null;
  }
  if (
    host === "challenges.cloudflare.com" &&
    u.pathname.startsWith("/cdn-cgi/challenge-platform/") &&
    u.pathname.includes("/turnstile/")
  )
    return "turnstile";
  if (hostIs(host, "arkoselabs.com") && u.pathname.startsWith("/fc/"))
    return "arkose";
  if (host === "geo.captcha-delivery.com" && u.pathname.startsWith("/captcha"))
    return "datadome";
  return null;
}

/** Whether a page is Cloudflare's full-page challenge. */
export function isCloudflareChallenge(page: TargetLite): boolean {
  if (page.title === CLOUDFLARE_CHALLENGE_TITLE) return true;
  const u = parse(page.url);
  return (
    u !== null &&
    [...u.searchParams.keys()].some((k) => k.startsWith("__cf_chl"))
  );
}

/** The top-level page above a target, walking at most a few parents (never in a loop). */
function rootPage(
  targets: ReadonlyMap<string, TargetLite>,
  t: TargetLite,
): TargetLite | null {
  let cur: TargetLite | undefined = t;
  const seen = new Set<TargetLite>();
  for (let i = 0; cur && i <= MAX_PARENT_HOPS; i++) {
    if (cur.type === "page") return cur;
    if (seen.has(cur) || !cur.parentId) return null;
    seen.add(cur);
    cur = targets.get(cur.parentId);
  }
  return null;
}

function pageHost(page: TargetLite | null): string | null {
  if (!page || page.url.length > MAX_TARGET_STRING) return null;
  try {
    const h = new URL(page.url).hostname.toLowerCase();
    return CaptchaHost.safeParse(h).success ? h : null;
  } catch {
    return null;
  }
}

/**
 * Every known CAPTCHA the targets show, as (provider, host) pairs: unique, in provider order
 * then host, at most `CAPTCHA_LIMITS.maxDetections`.
 */
export function matchCaptchas(
  targets: ReadonlyMap<string, TargetLite>,
): Detection[] {
  const found = new Map<string, Detection>();
  const add = (provider: CaptchaProvider, host: string | null) =>
    found.set(`${provider} ${host ?? ""}`, { provider, host });
  for (const t of targets.values()) {
    if (t.title.length > MAX_TARGET_STRING) continue;
    if (t.type === "page") {
      if (isCloudflareChallenge(t)) add("cloudflare_challenge", pageHost(t));
      continue;
    }
    if (t.type !== "iframe") continue;
    const provider = matchFrame(t.url);
    if (!provider) continue;
    const page = rootPage(targets, t);
    // Cloudflare's challenge page is itself a Turnstile: report the page, once.
    if (provider === "turnstile" && page && isCloudflareChallenge(page))
      continue;
    add(provider, pageHost(page));
  }
  const providers = captchaSet([...found.values()].map((d) => d.provider));
  return [...found.values()]
    .sort(
      (a, b) =>
        providers.indexOf(a.provider) - providers.indexOf(b.provider) ||
        (a.host ?? "").localeCompare(b.host ?? ""),
    )
    .slice(0, CAPTCHA_LIMITS.maxDetections);
}
