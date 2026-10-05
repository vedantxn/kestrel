import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captchaCheckConfigFromEnv } from "./captcha-check.js";

const PAGES = new URL(
  "../../../infra/terraform/main/testpage/captcha/",
  import.meta.url,
).pathname;

describe("bench captcha", () => {
  it("finds the CAPTCHA pages beside the test page", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    writeFileSync(join(dir, "key"), "ksl_x");
    const c = captchaCheckConfigFromEnv(
      {
        PUBLIC_HOSTNAME: "h.example",
        PUBLIC_IP: "1.2.3.4",
        API_KEY_FILE: join(dir, "key"),
        TEST_PAGE_URL:
          "https://kestrel-testpage-1.s3.us-east-1.amazonaws.com/test/index.html",
      },
      () => undefined,
    );
    expect(c.pagesUrl).toBe(
      "https://kestrel-testpage-1.s3.us-east-1.amazonaws.com/test/captcha/",
    );
    expect(c.nodes).toEqual(["a", "b"]);
  });

  it("has every page the check visits, using only the providers' official test keys", () => {
    const pages = readdirSync(PAGES).sort();
    expect(pages).toEqual([
      "flap.html",
      "hcaptcha.html",
      "interstitial.html",
      "plain.html",
      "recaptcha-invisible.html",
      "recaptcha.html",
      "turnstile-interactive.html",
      "turnstile.html",
    ]);
    const all = pages.map((p) => readFileSync(join(PAGES, p), "utf8")).join("");
    for (const key of all.match(/data-sitekey="([^"]+)"/g) ?? [])
      expect([
        'data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"',
        'data-sitekey="10000000-ffff-ffff-ffff-000000000001"',
        'data-sitekey="1x00000000000000000000AA"',
        'data-sitekey="3x00000000000000000000FF"',
      ]).toContain(key);
  });
});
