// W8: Stagehand v3 attached to a Kestrel session by its connectUrl. Prints RESULT: <title>.
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const stagehand = new Stagehand({
  env: "LOCAL",
  localBrowserLaunchOptions: { cdpUrl: process.env.CDP_URL },
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5-5",
  verbose: 0,
});
await stagehand.init();
try {
  const page = stagehand.context.pages()[0];
  await page.goto(process.env.TEST_PAGE_URL);
  const { title } = await stagehand.extract(
    "the page's main heading or title",
    z.object({ title: z.string() }),
  );
  console.log("RESULT:", title);
} finally {
  await stagehand.close();
}
