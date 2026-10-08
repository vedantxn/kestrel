# @kestrel/sdk

TypeScript client for [Kestrel](https://github.com/vedantxn/kestrel), open-source, self-hostable cloud browsers for AI agents.

```
npm i @kestrel/sdk playwright-core
```

```ts
import { Kestrel } from "@kestrel/sdk";

const kestrel = new Kestrel(); // reads KESTREL_URL and KESTREL_API_KEY
const { browser, close } = await kestrel.connect(); // a fresh, isolated Chrome
const page = browser.contexts()[0]!.pages()[0]!;
await page.goto("https://example.com");
console.log(await page.title());
await close(); // closes the browser and stops the session
```

Without Playwright, `kestrel.sessions.create()` returns a session whose `connectUrl` Puppeteer or any Chrome DevTools Protocol client can use. The full API is in the [agent docs](https://github.com/vedantxn/kestrel/tree/main/docs/agents).
