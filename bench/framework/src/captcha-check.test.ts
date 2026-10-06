import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captchaCheckConfigFromEnv } from "./captcha-check.js";
import { FAKE_TOKENS, FakeSolverService } from "./fake-solver.js";

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
    expect(c.solve).toBe(true);
    expect(c.solverPort).toBe(7390);
    expect(c.solverKeyFile).toBe("/secrets/captcha-solver.key");
  });

  it("has every page the check visits, using only the providers' official test keys", () => {
    const pages = readdirSync(PAGES).sort();
    expect(pages).toEqual([
      "aws-waf.html",
      "flap.html",
      "geetest.html",
      "hcaptcha.html",
      "interstitial-de.html",
      "interstitial.html",
      "perimeterx.html",
      "plain.html",
      "probe-traps.html",
      "recaptcha-explicit.html",
      "recaptcha-invisible.html",
      "recaptcha.html",
      "solve-fail.html",
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
    // The script-rendered page uses the same reCAPTCHA test key.
    expect(
      readFileSync(join(PAGES, "recaptcha-explicit.html"), "utf8"),
    ).toContain('sitekey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"');
  });
});

describe("the fake solver service", () => {
  let fake: FakeSolverService | undefined;
  afterEach(async () => fake?.close());

  /** The protocol as the services document it (apps/node/src/solver.ts lists the pages). */
  async function post(base: string, path: string, body: object) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  it("answers createTask, then processing, then ready with the provider's test token", async () => {
    fake = new FakeSolverService();
    const base = await fake.listen();
    for (const [type, field] of [
      ["RecaptchaV2TaskProxyless", "gRecaptchaResponse"],
      ["HCaptchaTaskProxyless", "gRecaptchaResponse"],
      ["TurnstileTaskProxyless", "token"],
    ] as const) {
      const created = await post(base, "/createTask", {
        clientKey: "k",
        task: {
          type,
          websiteURL: "https://x.example/p",
          websiteKey: "key12345",
          action: "a",
        },
      });
      expect(created.errorId).toBe(0);
      const taskId = created.taskId;
      expect(
        await post(base, "/getTaskResult", { clientKey: "k", taskId }),
      ).toEqual({
        errorId: 0,
        status: "processing",
      });
      const ready = await post(base, "/getTaskResult", {
        clientKey: "k",
        taskId,
      });
      expect(ready.status).toBe("ready");
      expect((ready.solution as Record<string, string>)[field]).toBe(
        FAKE_TOKENS[type],
      );
    }
    expect(fake.tasks.map((t) => t.fields)).toEqual([
      ["action"],
      ["action"],
      ["action"],
    ]);
  });

  it("fails a solve-fail page, refuses unknown tasks and missing keys", async () => {
    fake = new FakeSolverService();
    const base = await fake.listen();
    const created = await post(base, "/createTask", {
      clientKey: "k",
      task: {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: "https://x.example/test/captcha/solve-fail.html",
        websiteKey: "key12345",
      },
    });
    await post(base, "/getTaskResult", {
      clientKey: "k",
      taskId: created.taskId,
    });
    expect(
      await post(base, "/getTaskResult", {
        clientKey: "k",
        taskId: created.taskId,
      }),
    ).toMatchObject({ errorId: 12, errorCode: "ERROR_CAPTCHA_UNSOLVABLE" });
    expect(
      await post(base, "/createTask", {
        clientKey: "k",
        task: { type: "GeeTestTaskProxyless" },
      }),
    ).toMatchObject({ errorId: 1, errorCode: "ERROR_TASK_NOT_SUPPORTED" });
    expect(await post(base, "/createTask", { task: {} })).toMatchObject({
      errorCode: "ERROR_KEY_DOES_NOT_EXIST",
    });
  });
});
