import { KestrelClient } from "./client.js";
import {
  PlaywrightDriver,
  PlaywrightDiscoveryDriver,
  PuppeteerDriver,
} from "./driver.js";
import { runLifecycle } from "./lifecycle.js";

/** Check 10: real Playwright (wss and discovery) and Puppeteer scripts through the public gateway, run from outside AWS (or by anyone, through bin/verify). */
const client = new KestrelClient(
  process.env.KESTREL_URL as string,
  process.env.KESTREL_API_KEY as string,
  120_000,
);
// Any public page with a known title; the AWS deployment's own test page when it has one.
const testPageUrl = process.env.TEST_PAGE_URL || "https://example.com/";
const expectTitle =
  process.env.EXPECT_TITLE ||
  (process.env.TEST_PAGE_URL ? "Kestrel test page" : "Example Domain");
let bad = 0;
for (const [name, driver] of [
  ["playwright", new PlaywrightDriver()],
  ["playwright-discovery", new PlaywrightDiscoveryDriver()],
  ["puppeteer", new PuppeteerDriver()],
] as const) {
  const r = await runLifecycle(client, driver, {
    testPageUrl,
    expectTitle,
  });
  console.log(
    `${name}: ${r.ok ? "ok" : `FAILED ${r.phase}: ${r.error}`} in ${Math.round(r.totalMs)} ms`,
  );
  if (!r.ok) bad++;
}
process.exit(bad ? 1 : 0);
