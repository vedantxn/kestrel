import { createHash } from "node:crypto";
import {
  CAPTCHA_LIMITS,
  CAPTCHA_SOLVE_LIMITS,
  CaptchaHost,
  CaptchaSiteKey,
  captchaSet,
  isSolvable,
  type CaptchaProvider,
  type SolvableCaptchaProvider,
} from "@kestrel/contracts";

/**
 * Which known CAPTCHAs the browser shows (`docs/lld/captcha.md`, "What is matched"). Pure
 * functions over what Chrome reports: page and iframe targets with their URL, title and parent
 * (`Target.getTargets`), each page's in-process frames (`Page.getFrameTree`), and the page's own
 * signals read by the isolated-world probe. The URLs are the page's own (hostile) data: only
 * https, hosts matched exactly or as a dot-separated suffix, and nothing of a URL leaves here but
 * the top-level page's hostname (T-51), except for a session that solves, whose challenges carry
 * the site key and the page's origin and path.
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

/** A widget the probe found in a page (sessions that solve only). */
export interface Widget {
  provider: SolvableCaptchaProvider;
  siteKey: string | null;
  callback: string | null;
  invisible: boolean;
  action?: string;
  cdata?: string;
}

/** What the probe read in a page's top document, in an isolated world. */
export interface DomSignals {
  /** A Cloudflare challenge page's orchestration script or form: any language. */
  cloudflare: boolean;
  /** A shown `#px-captcha` (HUMAN press-and-hold). */
  perimeterx: boolean;
  /** A shown GeeTest v3 or v4 widget. */
  geetest: boolean;
  /** AWS WAF's CAPTCHA interstitial script. */
  awsWaf: boolean;
  widgets: Widget[];
}

/** Per page target: its in-process frames and, when probed, its DOM signals. */
export interface PageSignals {
  /** URLs (with fragment) of the page's frames that are not targets of their own. */
  frames: string[];
  dom: DomSignals | null;
}

/** A challenge a solver can be asked about. `pageId` stays inside runtimed. */
export interface Challenge {
  id: string;
  pageId: string;
  provider: SolvableCaptchaProvider;
  siteKey: string;
  pageUrl: string;
  host: string | null;
  invisible: boolean;
  action?: string;
  cdata?: string;
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

/** A frame's site key, read from its URL, for the providers the platform solves. */
export function siteKeyOf(
  provider: SolvableCaptchaProvider,
  url: string,
): string | null {
  const u = parse(url);
  if (!u) return null;
  const key =
    provider === "recaptcha"
      ? u.searchParams.get("k")
      : provider === "hcaptcha"
        ? new URLSearchParams(u.hash.slice(1)).get("sitekey")
        : (u.pathname
            .split("/")
            .find((s) => /^[0-3]x[0-9A-Za-z_-]{16,}$/.test(s)) ?? null);
  return key !== null && CaptchaSiteKey.safeParse(key).success ? key : null;
}

/** Whether a page is Cloudflare's full-page challenge. */
export function isCloudflareChallenge(
  page: TargetLite,
  signals?: PageSignals,
): boolean {
  if (signals?.dom?.cloudflare) return true;
  if (page.title === CLOUDFLARE_CHALLENGE_TITLE) return true;
  const u = parse(page.url);
  return (
    u !== null &&
    [...u.searchParams.keys()].some((k) => k.startsWith("__cf_chl"))
  );
}

/** The id of the top-level page above a target, walking at most a few parents (never in a loop). */
export function rootPageId(
  targets: ReadonlyMap<string, TargetLite>,
  id: string,
): string | null {
  let curId: string | undefined = id;
  const seen = new Set<string>();
  for (let i = 0; curId !== undefined && i <= MAX_PARENT_HOPS; i++) {
    const cur = targets.get(curId);
    if (!cur) return null;
    if (cur.type === "page") return curId;
    if (seen.has(curId) || !cur.parentId) return null;
    seen.add(curId);
    curId = cur.parentId;
  }
  return null;
}

function pageHost(page: TargetLite | undefined): string | null {
  if (!page || page.url.length > MAX_TARGET_STRING) return null;
  try {
    const h = new URL(page.url).hostname.toLowerCase();
    return CaptchaHost.safeParse(h).success ? h : null;
  } catch {
    return null;
  }
}

/** A solvable frame with the page it is in. */
interface FrameHit {
  provider: CaptchaProvider;
  url: string;
  pageId: string | null;
}

/** Every known CAPTCHA frame: frames that are targets, then frames in each page's frame tree. */
function frameHits(
  targets: ReadonlyMap<string, TargetLite>,
  pages: ReadonlyMap<string, PageSignals>,
): FrameHit[] {
  const hits: FrameHit[] = [];
  for (const [id, t] of targets) {
    if (t.type !== "iframe" || t.title.length > MAX_TARGET_STRING) continue;
    const provider = matchFrame(t.url);
    if (provider)
      hits.push({ provider, url: t.url, pageId: rootPageId(targets, id) });
  }
  // Same-site frames run in their page's process and are not targets: a reCAPTCHA on a Google
  // page, an hCaptcha on hcaptcha.com.
  for (const [pageId, s] of pages) {
    if (targets.get(pageId)?.type !== "page") continue;
    for (const url of s.frames) {
      const provider = matchFrame(url);
      if (provider) hits.push({ provider, url, pageId });
    }
  }
  return hits;
}

/**
 * Every known CAPTCHA showing, as (provider, host) pairs: unique, in provider order then host,
 * at most `CAPTCHA_LIMITS.maxDetections`.
 */
export function matchCaptchas(
  targets: ReadonlyMap<string, TargetLite>,
  pages: ReadonlyMap<string, PageSignals> = new Map(),
): Detection[] {
  const found = new Map<string, Detection>();
  const add = (provider: CaptchaProvider, host: string | null) =>
    found.set(`${provider} ${host ?? ""}`, { provider, host });
  const challengePage = new Map<string, boolean>();
  for (const [id, t] of targets) {
    if (t.type !== "page" || t.title.length > MAX_TARGET_STRING) continue;
    const s = pages.get(id);
    const cf = isCloudflareChallenge(t, s);
    challengePage.set(id, cf);
    const host = pageHost(t);
    if (cf) add("cloudflare_challenge", host);
    if (s?.dom?.perimeterx) add("perimeterx", host);
    if (s?.dom?.geetest) add("geetest", host);
    if (s?.dom?.awsWaf) add("aws_waf", host);
  }
  for (const h of frameHits(targets, pages)) {
    // Cloudflare's challenge page is itself a Turnstile: report the page, once.
    if (h.provider === "turnstile" && h.pageId && challengePage.get(h.pageId))
      continue;
    add(h.provider, pageHost(h.pageId ? targets.get(h.pageId) : undefined));
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

/** A page URL as a solver gets it: http(s) origin and path, no credentials, query or fragment. */
export function solverPageUrl(url: string): string | null {
  if (url.length > MAX_TARGET_STRING) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const out = `${u.origin}${u.pathname}`;
    return out.length <= CAPTCHA_SOLVE_LIMITS.pageUrlMaxLength ? out : null;
  } catch {
    return null;
  }
}

const challengeId = (pageId: string, provider: string, siteKey: string) =>
  createHash("sha256")
    .update(`${pageId}\n${provider}\n${siteKey}`)
    .digest("hex")
    .slice(0, 16);

const ATTR = /^[A-Za-z0-9_-]*$/;

/**
 * What a solver needs for each solvable widget showing, read from the frames (site keys are in
 * their URLs) and the probe's widgets (Turnstile's action and cData). Unique, at most
 * `CAPTCHA_SOLVE_LIMITS.maxChallenges`.
 */
export function findChallenges(
  targets: ReadonlyMap<string, TargetLite>,
  pages: ReadonlyMap<string, PageSignals>,
): Challenge[] {
  const out = new Map<string, Challenge>();
  for (const h of frameHits(targets, pages)) {
    if (!isSolvable(h.provider) || !h.pageId) continue;
    const page = targets.get(h.pageId);
    const signals = pages.get(h.pageId);
    if (
      !page ||
      (h.provider === "turnstile" && isCloudflareChallenge(page, signals))
    )
      continue; // a challenge page is not a widget a token can be put into
    const siteKey = siteKeyOf(h.provider, h.url);
    const pageUrl = solverPageUrl(page.url);
    if (!siteKey || !pageUrl) continue;
    const id = challengeId(h.pageId, h.provider, siteKey);
    if (out.has(id)) continue;
    const w = signals?.dom?.widgets.find(
      (x) => x.provider === h.provider && x.siteKey === siteKey,
    );
    out.set(id, {
      id,
      pageId: h.pageId,
      provider: h.provider,
      siteKey,
      pageUrl,
      host: pageHost(page),
      invisible: w?.invisible ?? false,
      ...(w?.action && ATTR.test(w.action) && w.action.length <= 64
        ? { action: w.action }
        : {}),
      ...(w?.cdata && ATTR.test(w.cdata) && w.cdata.length <= 255
        ? { cdata: w.cdata }
        : {}),
    });
    if (out.size >= CAPTCHA_SOLVE_LIMITS.maxChallenges) break;
  }
  return [...out.values()];
}
