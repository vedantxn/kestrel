import { describe, expect, it } from "vitest";
import {
  MAX_TARGET_STRING,
  matchCaptchas,
  matchFrame,
  type TargetLite,
} from "./captcha-match.js";

// URL shapes recorded by the spike (Chrome for Testing 154, official test keys), docs/lld/captcha.md.
const RC_ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&co=aHR0cDovL2xvY2FsaG9zdDo4MDAw&hl=en&v=guXhH0v&size=normal&anchor-ms=20000&execute-ms=30000&cb=x1";
const RC_INVISIBLE = RC_ANCHOR.replace("size=normal", "size=invisible");
const RC_BFRAME =
  "https://www.google.com/recaptcha/api2/bframe?hl=en&v=guXhH0v&k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI&bft=0";
const HC_BASE =
  "https://newassets.hcaptcha.com/captcha/v1/05219f0822161da4c4a6f3aed6bf6d6fae1ba8e1/static/hcaptcha.html";
const HC_CHECKBOX = `${HC_BASE}#frame=checkbox&id=09uhpibcjmpn&host=localhost&sentry=true`;
const HC_CHALLENGE = `${HC_BASE}#frame=challenge&id=09uhpibcjmpn&host=localhost`;
const HC_INVISIBLE = `${HC_BASE}#frame=checkbox-invisible&id=0h23d0hnpo2h`;
const TURNSTILE =
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/3379y/1x00000000000000000000AA/auto/fbE/new/normal?lang=auto";

describe("matchFrame", () => {
  it.each([
    [RC_ANCHOR, "recaptcha"],
    [RC_ANCHOR.replace("api2", "enterprise"), "recaptcha"],
    [RC_ANCHOR.replace("www.google.com", "www.recaptcha.net"), "recaptcha"],
    [RC_ANCHOR.replace("size=normal", "size=compact"), "recaptcha"],
    [HC_CHECKBOX, "hcaptcha"],
    [HC_CHECKBOX.replace("newassets.", "assets."), "hcaptcha"],
    [TURNSTILE, "turnstile"],
    ["https://client-api.arkoselabs.com/fc/gc/?token=abc", "arkose"],
    ["https://geo.captcha-delivery.com/captcha/?initialCid=x", "datadome"],
  ])("matches %s as %s", (url, provider) => {
    expect(matchFrame(url)).toBe(provider);
  });

  it.each([
    ["invisible reCAPTCHA", RC_INVISIBLE],
    ["reCAPTCHA's hidden challenge frame", RC_BFRAME],
    ["hCaptcha's hidden challenge frame", HC_CHALLENGE],
    ["invisible hCaptcha", HC_INVISIBLE],
    ["plain http", RC_ANCHOR.replace("https:", "http:")],
    [
      "a look-alike host",
      RC_ANCHOR.replace("www.google.com", "www.google.com.evil.example"),
    ],
    [
      "a look-alike suffix",
      HC_CHECKBOX.replace("hcaptcha.com", "nothcaptcha.com"),
    ],
    [
      "another google path",
      "https://www.google.com/search?q=recaptcha/api2/anchor",
    ],
    [
      "turnstile's script, not its frame",
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
    ],
    ["a malformed URL", "https://%%%"],
    ["an empty URL", ""],
    ["an oversized URL", RC_ANCHOR + "&x=" + "a".repeat(MAX_TARGET_STRING)],
  ])("ignores %s", (_why, url) => {
    expect(matchFrame(url)).toBeNull();
  });
});

const page = (url: string, title = "page"): TargetLite => ({
  type: "page",
  url,
  title,
});
const frame = (url: string, parentId: string): TargetLite => ({
  type: "iframe",
  url,
  title: url,
  parentId,
});
const targets = (entries: [string, TargetLite][]) => new Map(entries);

describe("matchCaptchas", () => {
  it("reports the provider and the hostname of the page it is on, never more of the URL", () => {
    const d = matchCaptchas(
      targets([
        ["p1", page("https://Shop.Example.com/login?next=/secret#frag")],
        ["f1", frame(RC_ANCHOR, "p1")],
        ["f2", frame(RC_BFRAME, "p1")],
      ]),
    );
    expect(d).toEqual([{ provider: "recaptcha", host: "shop.example.com" }]);
  });

  it("walks nested frames up to their page", () => {
    const d = matchCaptchas(
      targets([
        ["p1", page("https://outer.example/")],
        ["f1", frame("https://inner.example/embed", "p1")],
        ["f2", frame(HC_CHECKBOX, "f1")],
      ]),
    );
    expect(d).toEqual([{ provider: "hcaptcha", host: "outer.example" }]);
  });

  it("gives no host for an orphan, a parent loop or a too-deep chain", () => {
    expect(
      matchCaptchas(targets([["f1", frame(TURNSTILE, "missing")]])),
    ).toEqual([{ provider: "turnstile", host: null }]);
    expect(
      matchCaptchas(
        targets([
          ["a", frame("https://a.example/", "b")],
          ["b", frame("https://b.example/", "a")],
          ["f", frame(TURNSTILE, "a")],
        ]),
      ),
    ).toEqual([{ provider: "turnstile", host: null }]);
    const chain: [string, TargetLite][] = [
      ["p", page("https://deep.example/")],
    ];
    for (let i = 0; i < 12; i++)
      chain.push([`f${i}`, frame("https://x.example/", i ? `f${i - 1}` : "p")]);
    chain.push(["cap", frame(TURNSTILE, "f11")]);
    expect(matchCaptchas(targets(chain))).toEqual([
      { provider: "turnstile", host: null },
    ]);
  });

  it("reports Cloudflare's challenge page by title or __cf_chl key, and not its Turnstile again", () => {
    expect(
      matchCaptchas(
        targets([
          ["p1", page("https://site.example/", "Just a moment...")],
          ["f1", frame(TURNSTILE, "p1")],
        ]),
      ),
    ).toEqual([{ provider: "cloudflare_challenge", host: "site.example" }]);
    expect(
      matchCaptchas(
        targets([["p1", page("https://site.example/?__cf_chl_tk=abc", "x")]]),
      ),
    ).toEqual([{ provider: "cloudflare_challenge", host: "site.example" }]);
    expect(
      matchCaptchas(
        targets([["p1", page("https://site.example/", "Just a moment")]]),
      ),
    ).toEqual([]);
  });

  it("lists several, ordered and unique, and ignores other target types", () => {
    const d = matchCaptchas(
      targets([
        ["p1", page("https://b.example/")],
        ["p2", page("https://a.example/")],
        ["t", frame(TURNSTILE, "p1")],
        ["r1", frame(RC_ANCHOR, "p1")],
        ["r2", frame(RC_ANCHOR, "p2")],
        ["r3", frame(RC_ANCHOR + "&cb=again", "p2")],
        ["w", { type: "service_worker", url: RC_ANCHOR, title: "" }],
      ]),
    );
    expect(d).toEqual([
      { provider: "recaptcha", host: "a.example" },
      { provider: "recaptcha", host: "b.example" },
      { provider: "turnstile", host: "b.example" },
    ]);
  });

  it("returns at most 16 and skips oversized titles", () => {
    const many: [string, TargetLite][] = [];
    for (let i = 0; i < 40; i++) {
      many.push([
        `p${i}`,
        page(`https://h${String(i).padStart(2, "0")}.example/`),
      ]);
      many.push([`f${i}`, frame(RC_ANCHOR, `p${i}`)]);
    }
    expect(matchCaptchas(targets(many))).toHaveLength(16);
    expect(
      matchCaptchas(
        targets([
          [
            "p",
            {
              ...page("https://x.example/"),
              title: "Just a moment..." + "x".repeat(MAX_TARGET_STRING),
            },
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("finds nothing on a page without CAPTCHAs", () => {
    expect(
      matchCaptchas(
        targets([
          ["p1", page("https://example.com/")],
          ["f1", frame("https://ads.example/frame", "p1")],
          ["f2", frame(RC_INVISIBLE, "p1")],
        ]),
      ),
    ).toEqual([]);
  });
});
