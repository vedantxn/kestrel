import { describe, expect, it } from "vitest";
import {
  MAX_TARGET_STRING,
  findChallenges,
  matchCaptchas,
  matchFrame,
  siteKeyOf,
  solverPageUrl,
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

  it("sees same-site frames from a page's frame tree, with the page's host", () => {
    // A reCAPTCHA on a Google page and an hCaptcha on hcaptcha.com: not targets (spike 2).
    const pages = new Map([
      ["g", { frames: [RC_ANCHOR, RC_BFRAME, "about:blank"], dom: null }],
      ["h", { frames: [HC_CHECKBOX, HC_CHALLENGE], dom: null }],
    ]);
    expect(
      matchCaptchas(
        targets([
          ["g", page("https://www.google.com/recaptcha/api2/demo")],
          ["h", page("https://accounts.hcaptcha.com/demo")],
        ]),
        pages,
      ),
    ).toEqual([
      { provider: "recaptcha", host: "www.google.com" },
      { provider: "hcaptcha", host: "accounts.hcaptcha.com" },
    ]);
    // Signals for a target that is not a page are ignored.
    expect(
      matchCaptchas(
        targets([["f", frame("https://x.example/", "missing")]]),
        new Map([["f", { frames: [RC_ANCHOR], dom: null }]]),
      ),
    ).toEqual([]);
  });

  it("reports in-page widgets and a Cloudflare challenge in any language from the probe", () => {
    const dom = {
      cloudflare: false,
      perimeterx: false,
      geetest: false,
      awsWaf: false,
      widgets: [],
    };
    const t = targets([
      ["p1", page("https://shop.example/", "Nur einen Moment…")],
      ["f1", frame(TURNSTILE, "p1")],
      ["p2", page("https://blocked.example/")],
      ["p3", page("https://login.example/")],
      ["p4", page("https://waf.example/")],
    ]);
    // Without the probe, the German challenge reads as a plain Turnstile.
    expect(matchCaptchas(t)).toEqual([
      { provider: "turnstile", host: "shop.example" },
    ]);
    const pages = new Map([
      ["p1", { frames: [], dom: { ...dom, cloudflare: true } }],
      ["p2", { frames: [], dom: { ...dom, perimeterx: true } }],
      ["p3", { frames: [], dom: { ...dom, geetest: true } }],
      ["p4", { frames: [], dom: { ...dom, awsWaf: true } }],
    ]);
    expect(matchCaptchas(t, pages)).toEqual([
      { provider: "cloudflare_challenge", host: "shop.example" },
      { provider: "perimeterx", host: "blocked.example" },
      { provider: "geetest", host: "login.example" },
      { provider: "aws_waf", host: "waf.example" },
    ]);
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

describe("siteKeyOf", () => {
  it("reads each provider's site key from its frame URL", () => {
    expect(siteKeyOf("recaptcha", RC_ANCHOR)).toBe(
      "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
    );
    expect(
      siteKeyOf(
        "hcaptcha",
        `${HC_BASE}#frame=checkbox&id=x&sitekey=10000000-ffff-ffff-ffff-000000000001`,
      ),
    ).toBe("10000000-ffff-ffff-ffff-000000000001");
    expect(siteKeyOf("turnstile", TURNSTILE)).toBe("1x00000000000000000000AA");
    // Recorded from a real Cloudflare challenge page in the spike.
    expect(
      siteKeyOf(
        "turnstile",
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/5n6zz/0x4AAAAAAADnPIDROrmt1Wwj/dark",
      ),
    ).toBe("0x4AAAAAAADnPIDROrmt1Wwj");
  });

  it("refuses a key that is not a site key", () => {
    expect(
      siteKeyOf("recaptcha", RC_ANCHOR.replace(/k=[^&]+/, "k=%3Cscript%3E")),
    ).toBeNull();
    expect(
      siteKeyOf("recaptcha", RC_ANCHOR.replace(/k=[^&]+/, "k=")),
    ).toBeNull();
    expect(siteKeyOf("hcaptcha", HC_CHECKBOX)).toBeNull();
    expect(
      siteKeyOf("recaptcha", "http://www.google.com/x?k=abcdefghij"),
    ).toBeNull();
  });
});

describe("solverPageUrl", () => {
  it("keeps the origin and path only", () => {
    expect(
      solverPageUrl(
        "https://user:pw@Shop.example:8443/login?next=/secret#frag",
      ),
    ).toBe("https://shop.example:8443/login");
    expect(solverPageUrl("http://localhost:8000/recaptcha.html")).toBe(
      "http://localhost:8000/recaptcha.html",
    );
    for (const bad of [
      "about:blank",
      "data:text/html,x",
      "file:///etc/passwd",
      "%%",
    ])
      expect(solverPageUrl(bad)).toBeNull();
  });
});

describe("findChallenges", () => {
  const HC = `${HC_BASE}#frame=checkbox&id=x&sitekey=10000000-ffff-ffff-ffff-000000000001`;
  const noDom = {
    cloudflare: false,
    perimeterx: false,
    geetest: false,
    awsWaf: false,
  };

  it("gives each solvable widget's site key and page, and Turnstile's action and cData", () => {
    const t = targets([
      ["p1", page("https://shop.example/login?token=secret")],
      ["f1", frame(RC_ANCHOR, "p1")],
      ["f2", frame(TURNSTILE, "p1")],
      ["f3", frame("https://client-api.arkoselabs.com/fc/gc/?token=x", "p1")],
      ["p2", page("https://accounts.hcaptcha.com/demo")],
    ]);
    const pages = new Map([
      ["p2", { frames: [HC], dom: null }],
      [
        "p1",
        {
          frames: [],
          dom: {
            ...noDom,
            widgets: [
              {
                provider: "turnstile" as const,
                siteKey: "1x00000000000000000000AA",
                callback: "ok",
                invisible: false,
                action: "login",
                cdata: "has space",
              },
            ],
          },
        },
      ],
    ]);
    const c = findChallenges(t, pages);
    expect(c.map((x) => [x.provider, x.siteKey, x.pageUrl, x.host])).toEqual([
      [
        "recaptcha",
        "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
        "https://shop.example/login",
        "shop.example",
      ],
      [
        "turnstile",
        "1x00000000000000000000AA",
        "https://shop.example/login",
        "shop.example",
      ],
      [
        "hcaptcha",
        "10000000-ffff-ffff-ffff-000000000001",
        "https://accounts.hcaptcha.com/demo",
        "accounts.hcaptcha.com",
      ],
    ]);
    const ts = c.find((x) => x.provider === "turnstile")!;
    expect(ts.action).toBe("login");
    expect(ts.cdata).toBeUndefined(); // not a plain token: dropped
    expect(new Set(c.map((x) => x.id)).size).toBe(3);
    expect(c.every((x) => /^[0-9a-f]{16}$/.test(x.id))).toBe(true);
  });

  it("leaves out a challenge page's Turnstile, keyless and orphan frames and duplicates, and stops at 8", () => {
    expect(
      findChallenges(
        targets([
          ["p1", page("https://site.example/", "Just a moment...")],
          ["f1", frame(TURNSTILE, "p1")],
          ["p2", page("https://other.example/")],
          ["f2", frame(HC_CHECKBOX, "p2")],
          ["f3", frame(RC_ANCHOR, "p2")],
          ["f4", frame(RC_ANCHOR + "&cb=2", "p2")],
          ["f5", frame(RC_ANCHOR, "missing")],
        ]),
        new Map(),
      ).map((x) => x.provider),
    ).toEqual(["recaptcha"]);
    const many: [string, TargetLite][] = [];
    for (let i = 0; i < 20; i++) {
      many.push([`p${i}`, page(`https://h${i}.example/`)]);
      many.push([`f${i}`, frame(RC_ANCHOR, `p${i}`)]);
    }
    expect(findChallenges(targets(many), new Map())).toHaveLength(8);
  });
});
