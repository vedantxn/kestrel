import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Browser, type Page } from "playwright-core";
import WebSocket from "ws";
import type { Session } from "@kestrel/contracts";
import { KestrelClient } from "./client.js";
import { m1ConfigFromEnv } from "./m1.js";
import { makeReport, type Report } from "./report.js";

/**
 * The v2 exit check (docs/v2-plan.md, Verification 3-5): tokens and live view, `/computer`,
 * recording, Kestrel's own MCP server, and Playwright MCP pointed at a session. Each check
 * drives the real deployment the way a user or an agent would. v1's `m1` runs separately to show
 * nothing regressed.
 */
export interface M2Config {
  apiUrl: string;
  apiKey: string;
  testPageUrl: string;
  /** Seconds of recorded activity in the recording check. */
  recordSeconds: number;
  environment: Record<string, string | number>;
  only?: number[];
  log: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["stopped", "failed", "timed_out"] as const;

/** A page whose effects are easy to check: a button that counts clicks and a text box. */
const FIXTURE = `<!doctype html><title>fixture</title>
<style>body{margin:0}#b{position:absolute;left:100px;top:100px;width:200px;height:100px}
#i{position:absolute;left:100px;top:300px;width:300px;height:40px}</style>
<button id="b" onclick="window.clicks=(window.clicks||0)+1">click</button><input id="i">`;

async function open(
  client: KestrelClient,
  opts: Record<string, unknown> = {},
): Promise<{ session: Session; browser: Browser; page: Page }> {
  const { session } = await client.create({
    waitForCapacityMs: 30_000,
    ...opts,
  });
  const browser = await chromium.connectOverCDP(session.connectUrl as string, {
    timeout: 30_000,
  });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { session, browser, page };
}

async function close(
  client: KestrelClient,
  h: { session: Session; browser: Browser },
): Promise<void> {
  await h.browser.close().catch(() => undefined);
  await client.stop(h.session.id).catch(() => undefined);
}

/** A live-view socket from a minted token, collecting what the viewer is sent. */
async function viewer(
  client: KestrelClient,
  sessionId: string,
  scope: "view" | "control",
): Promise<{
  ws: WebSocket;
  frames: () => number;
  tabs: () => { title: string; url: string }[];
  send: (m: object) => void;
}> {
  const t = await client.mintToken(sessionId, { scope });
  const frag = new URLSearchParams(new URL(t.url).hash.slice(1));
  const ws = new WebSocket(
    `${frag.get("ws")}?token=${encodeURIComponent(t.token)}`,
    { perMessageDeflate: false },
  );
  let frames = 0;
  let tabs: { title: string; url: string }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as { type: string; tabs?: typeof tabs };
    if (m.type === "frame") frames++;
    else if (m.type === "tabs" && m.tabs) tabs = m.tabs;
  });
  await new Promise<void>(
    (res, rej) => (ws.once("open", () => res()), ws.once("error", rej)),
  );
  return {
    ws,
    frames: () => frames,
    tabs: () => tabs,
    send: (m) => ws.send(JSON.stringify(m)),
  };
}

async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | false> | T | false,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(`${what} did not happen within ${ms / 1000} s`);
    await sleep(200);
  }
}

const clickAt = (v: { send: (m: object) => void }, x: number, y: number) => {
  v.send({ type: "mouse", action: "down", x, y, button: "left" });
  v.send({ type: "mouse", action: "up", x, y, button: "left" });
};

/** Top-level MP4 boxes, enough to see a fragmented file's shape without a decoder. */
export function mp4Boxes(b: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= b.length) {
    let size = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    if (size === 1 && off + 16 <= b.length)
      size = Number(b.readBigUInt64BE(off + 8));
    if (size < 8) break;
    out.push(type);
    off += size;
  }
  return out;
}

const textOf = (r: unknown): string =>
  (
    ((r as { content?: unknown }).content as {
      type: string;
      text?: string;
    }[]) ?? []
  )
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

export async function runM2(c: M2Config): Promise<Report> {
  const client = new KestrelClient(c.apiUrl, c.apiKey, 120_000);
  const report = makeReport("m2-exit-check", c.environment);
  const want = (n: number) => !c.only || c.only.includes(n);
  const check = async (
    id: string,
    name: string,
    fn: () => Promise<string>,
  ): Promise<void> => {
    c.log(`check ${id}: ${name}`);
    try {
      report.add({ id, name, pass: true, detail: await fn() });
    } catch (e) {
      report.add({
        id,
        name,
        pass: false,
        detail: (e as Error).message.slice(0, 600),
      });
    }
  };

  if (want(1))
    await check(
      "1",
      "a view token sees but cannot act; a control token acts",
      async () => {
        const h = await open(client);
        try {
          await h.page.setContent(FIXTURE);
          const view = await viewer(client, h.session.id, "view");
          await until(
            "a frame for the view socket",
            10_000,
            () => view.frames() > 0,
          );
          clickAt(view, 200, 150);
          view.send({ type: "text", text: "nope" });
          await sleep(1500);
          const afterView = await h.page.evaluate("window.clicks || 0");
          if (afterView !== 0)
            throw new Error(
              `a view token's click landed (${String(afterView)} clicks)`,
            );
          const control = await viewer(client, h.session.id, "control");
          await until(
            "a frame for the control socket",
            10_000,
            () => control.frames() > 0,
          );
          clickAt(control, 200, 150);
          await until(
            "the control click to land",
            5_000,
            async () => (await h.page.evaluate("window.clicks || 0")) === 1,
          );
          view.ws.close();
          control.ws.close();
          return `view: 0 clicks after input; control: 1 click; ${view.frames()} frames to the view socket`;
        } finally {
          await close(client, h);
        }
      },
    );

  if (want(2))
    await check("2", "live view follows the page and its tabs", async () => {
      const h = await open(client);
      try {
        const v = await viewer(client, h.session.id, "view");
        await until("a first frame", 10_000, () => v.frames() > 0);
        const before = v.frames();
        const t0 = Date.now();
        await h.page.goto(c.testPageUrl);
        await until(
          "frames after a navigation",
          10_000,
          () => v.frames() > before,
        );
        const fps = (v.frames() - before) / ((Date.now() - t0) / 1000);
        const p2 = await h.browser.contexts()[0]!.newPage();
        await p2.setContent("<title>second tab</title>");
        await until("the new tab in the tab list", 10_000, () =>
          v.tabs().some((t) => t.title === "second tab"),
        );
        v.ws.close();
        return `frames kept coming after navigation (~${fps.toFixed(1)} per second while loading); tabs: ${v
          .tabs()
          .map((t) => t.title)
          .join(", ")}`;
      } finally {
        await close(client, h);
      }
    });

  if (want(3))
    await check("3", "/computer: screenshot, click, type", async () => {
      const h = await open(client, { viewport: { width: 1280, height: 720 } });
      try {
        await h.page.setContent(FIXTURE);
        const shot = await client.computer(h.session.id, {
          action: "screenshot",
        });
        const png = Buffer.from(shot.screenshot ?? "", "base64");
        if (png.toString("latin1", 1, 4) !== "PNG")
          throw new Error("the screenshot is not a PNG");
        const w = png.readUInt32BE(16);
        const hgt = png.readUInt32BE(20);
        if (w !== 1280 || hgt !== 720)
          throw new Error(`the screenshot is ${w}x${hgt}, wanted 1280x720`);
        await client.computer(h.session.id, {
          action: "click",
          x: 200,
          y: 150,
        });
        await client.computer(h.session.id, {
          action: "click",
          x: 250,
          y: 320,
        });
        await client.computer(h.session.id, {
          action: "type",
          text: "hello kestrel",
        });
        const after = await client.computer(h.session.id, {
          action: "key",
          key: "Enter",
          screenshot: true,
        });
        const clicks = await h.page.evaluate("window.clicks || 0");
        const value = await h.page.inputValue("#i");
        if (clicks !== 1)
          throw new Error(`the click did not land (${String(clicks)} clicks)`);
        if (value !== "hello kestrel")
          throw new Error(`typed text is ${JSON.stringify(value)}`);
        if (!after.screenshot)
          throw new Error("no screenshot after an action that asked for one");
        return `PNG ${w}x${hgt}; click landed; typed "${value}"`;
      } finally {
        await close(client, h);
      }
    });

  if (want(4))
    await check(
      "4",
      `a ${c.recordSeconds} s recording plays back, and outlives its container`,
      async () => {
        const h = await open(client, { recording: true });
        const t0 = Date.now();
        try {
          await h.page.goto(c.testPageUrl);
          while (Date.now() - t0 < c.recordSeconds * 1000) {
            await h.page.evaluate(
              "document.body.style.background = '#' + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0')",
            );
            await sleep(500);
          }
          const during = await client.recording(h.session.id);
          if (!during || during.length === 0)
            throw new Error("no recording while the session runs");
        } finally {
          await close(client, h);
        }
        await client.waitFor(h.session.id, [...TERMINAL], 60_000);
        const bytes = await until(
          "the recording after the session",
          20_000,
          async () => (await client.recording(h.session.id)) ?? false,
        );
        const boxes = mp4Boxes(bytes);
        const frags = boxes.filter((b) => b === "moof").length;
        if (boxes[0] !== "ftyp" || !boxes.includes("moov"))
          throw new Error(`not an MP4: ${boxes.slice(0, 4).join(",")}`);
        const expected = Math.floor(c.recordSeconds / 2) - 2;
        if (frags < expected)
          throw new Error(
            `${frags} fragments, wanted at least ${expected} for ${c.recordSeconds} s`,
          );
        return `${(bytes.length / 1024).toFixed(0)} KiB, ${frags} fragments (~${frags * 2} s), still served after the container was removed`;
      },
    );

  if (want(5))
    await check(
      "5",
      "Kestrel's MCP server: create, navigate, read, screenshot, live view, stop",
      async () => {
        const mcp = new Client({ name: "kestrel-m2", version: "1" });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL("/mcp", c.apiUrl), {
            requestInit: { headers: { authorization: `Bearer ${c.apiKey}` } },
          }),
        );
        try {
          const tools = (await mcp.listTools()).tools.map((t) => t.name);
          const created = await mcp.callTool({
            name: "create_session",
            arguments: {},
          });
          const id = /"id"\s*:\s*"(ses_[0-9a-z]+)"/.exec(textOf(created))?.[1];
          if (!id)
            throw new Error(
              `create_session gave no id: ${textOf(created).slice(0, 200)}`,
            );
          try {
            await mcp.callTool({
              name: "navigate",
              arguments: { sessionId: id, url: c.testPageUrl },
            });
            const text = textOf(
              await mcp.callTool({
                name: "get_page_text",
                arguments: { sessionId: id },
              }),
            );
            if (!/kestrel/i.test(text))
              throw new Error(
                `page text does not mention the test page: ${text.slice(0, 120)}`,
              );
            const shot = await mcp.callTool({
              name: "screenshot",
              arguments: { sessionId: id },
            });
            if (
              !(shot.content as { type: string }[]).some(
                (x) => x.type === "image",
              )
            )
              throw new Error("screenshot returned no image");
            const live = textOf(
              await mcp.callTool({
                name: "get_live_view_url",
                arguments: { sessionId: id },
              }),
            );
            if (!/\/live\/ses_/.test(live)) throw new Error("no live view URL");
          } finally {
            await mcp.callTool({
              name: "stop_session",
              arguments: { sessionId: id },
            });
          }
          return `${tools.length} tools; full round trip through /mcp`;
        } finally {
          await mcp.close();
        }
      },
    );

  if (want(6))
    await check(
      "6",
      "Playwright MCP pointed at a session (--cdp-endpoint)",
      async () => {
        const { session } = await client.create({ waitForCapacityMs: 30_000 });
        const mcp = new Client({ name: "kestrel-m2-pwmcp", version: "1" });
        try {
          await mcp.connect(
            new StdioClientTransport({
              command: "node",
              args: [
                require_resolve_playwright_mcp(),
                "--cdp-endpoint",
                session.connectUrl as string,
              ],
            }),
          );
          await mcp.callTool({
            name: "browser_navigate",
            arguments: { url: c.testPageUrl },
          });
          const snap = textOf(
            await mcp.callTool({ name: "browser_snapshot", arguments: {} }),
          );
          if (!/Kestrel test page/i.test(snap))
            throw new Error(
              `snapshot lacks the page title: ${snap.slice(0, 160)}`,
            );
          return "navigated and read an accessibility snapshot through Kestrel";
        } finally {
          await mcp.close().catch(() => undefined);
          await client.stop(session.id).catch(() => undefined);
        }
      },
    );

  return report.build();
}

import { createRequire } from "node:module";
function require_resolve_playwright_mcp(): string {
  return createRequire(import.meta.url).resolve("@playwright/mcp/cli.js");
}

export function m2ConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): M2Config {
  const base = m1ConfigFromEnv(env, log);
  return {
    apiUrl: base.apiUrl,
    apiKey: base.apiKey,
    testPageUrl: base.testPageUrl,
    recordSeconds: Number(env.RECORD_SECONDS ?? (env.QUICK === "1" ? 20 : 60)),
    environment: base.environment,
    ...(env.ONLY ? { only: env.ONLY.split(",").map(Number) } : {}),
    log,
  };
}
