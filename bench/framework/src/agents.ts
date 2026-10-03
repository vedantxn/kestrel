import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { KestrelClient } from "./client.js";

/**
 * W8. Real agents against a real deployment, from outside AWS (docs/v2-plan.md, Verification 5):
 * a Claude computer-use loop over `/computer`, browser-use, and Stagehand. Each has a fixed task
 * whose outcome the harness checks itself, never by trusting the agent's own report. They call
 * an LLM, which costs money: each run is capped in steps, and the whole file runs only when an
 * `ANTHROPIC_API_KEY` is set.
 *
 *   KESTREL_URL=https://<host> KESTREL_API_KEY=ksl_... ANTHROPIC_API_KEY=... TEST_PAGE_URL=... \
 *     node bench/framework/dist/agents.js [claude|browser-use|stagehand ...]
 */
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const MODEL = env.AGENT_MODEL ?? "claude-sonnet-5-5";
/**
 * The 2026 computer toolset: no display size (the model reads it from the screenshots), no beta
 * header. Older models take `computer_20250124` with `COMPUTER_BETA=computer-use-2025-01-24`.
 */
const TOOL_VERSION = env.COMPUTER_TOOL ?? "computer_toolset_20260801";
const TOOL_BETA = env.COMPUTER_BETA;
const MAX_STEPS = Number(env.AGENT_MAX_STEPS ?? 20);

const FIXTURE = `<!doctype html><title>agent fixture</title>
<style>body{margin:0;font:20px sans-serif}#b{position:absolute;left:100px;top:100px;width:220px;height:90px;font-size:22px}
#i{position:absolute;left:100px;top:260px;width:320px;height:44px;font-size:20px}</style>
<button id="b" onclick="window.clicks=(window.clicks||0)+1;this.textContent='Clicked '+window.clicks">Click me</button>
<input id="i" placeholder="Type here">`;

/** Claude's xdotool-style key names, to the DOM names `/computer` takes. */
const KEY_NAMES: Record<string, string> = {
  Return: "Enter",
  KP_Enter: "Enter",
  BackSpace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Home: "Home",
  End: "End",
  Page_Up: "PageUp",
  Page_Down: "PageDown",
  Delete: "Delete",
  space: " ",
};

type Block = { type: string; [k: string]: unknown };

async function claude(
  messages: unknown[],
  width: number,
  height: number,
): Promise<{ content: Block[]; stop_reason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": need("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      ...(TOOL_BETA ? { "anthropic-beta": TOOL_BETA } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [
        TOOL_VERSION.startsWith("computer_toolset")
          ? { type: TOOL_VERSION }
          : {
              type: TOOL_VERSION,
              name: "computer",
              display_width_px: width,
              display_height_px: height,
            },
      ],
      messages,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok)
    throw new Error(
      `Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  return (await res.json()) as never;
}

/** Run one computer-use action through `/computer`; returns a screenshot (base64 PNG) or an error message. */
async function act(
  k: KestrelClient,
  id: string,
  input: Record<string, unknown>,
): Promise<{ png?: string; error?: string }> {
  const xy = input.coordinate as [number, number] | undefined;
  const shot = { screenshot: true };
  switch (input.action) {
    case "screenshot":
      return {
        png: (await k.computer(id, { action: "screenshot" })).screenshot!,
      };
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      if (!xy) return { error: "a click needs a coordinate" };
      const button =
        input.action === "right_click"
          ? "right"
          : input.action === "middle_click"
            ? "middle"
            : "left";
      const clicks =
        input.action === "double_click"
          ? 2
          : input.action === "triple_click"
            ? 3
            : 1;
      return {
        png: (
          await k.computer(id, {
            action: "click",
            x: xy[0],
            y: xy[1],
            button,
            clicks,
            ...shot,
          })
        ).screenshot!,
      };
    }
    case "mouse_move":
      if (!xy) return { error: "mouse_move needs a coordinate" };
      return {
        png: (
          await k.computer(id, { action: "move", x: xy[0], y: xy[1], ...shot })
        ).screenshot!,
      };
    case "type":
      return {
        png: (
          await k.computer(id, {
            action: "type",
            text: String(input.text),
            ...shot,
          })
        ).screenshot!,
      };
    case "key": {
      const name = KEY_NAMES[String(input.text)] ?? String(input.text);
      if (name.includes("+"))
        return {
          error: `key combinations (${name}) are not supported by /computer`,
        };
      return {
        png: (await k.computer(id, { action: "key", key: name, ...shot }))
          .screenshot!,
      };
    }
    case "scroll": {
      if (!xy) return { error: "scroll needs a coordinate" };
      const amount = Number(input.scroll_amount ?? 3) * 100;
      const dir = String(input.scroll_direction ?? "down");
      const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
      const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
      return {
        png: (
          await k.computer(id, {
            action: "scroll",
            x: xy[0],
            y: xy[1],
            dx,
            dy,
            ...shot,
          })
        ).screenshot!,
      };
    }
    case "wait":
      await new Promise((r) => setTimeout(r, 1000));
      return {
        png: (await k.computer(id, { action: "screenshot" })).screenshot!,
      };
    default:
      return { error: `action ${String(input.action)} is not supported` };
  }
}

/** Claude computer use, through `/computer` only (no CDP client on the agent's side). */
export async function claudeComputerUse(k: KestrelClient): Promise<string> {
  const { session } = await k.create({
    viewport: { width: 1280, height: 720 },
    waitForCapacityMs: 30_000,
  });
  const browser = await chromium.connectOverCDP(session.connectUrl as string);
  try {
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.setContent(FIXTURE);
    const messages: unknown[] = [
      {
        role: "user",
        content:
          "You are controlling a web browser through screenshots and mouse and keyboard actions. On the page, click the button labelled 'Click me' exactly three times, then click the text box and type the word done. Take a screenshot first. When you have finished, reply with the single word FINISHED.",
      },
    ];
    let steps = 0;
    for (; steps < MAX_STEPS; steps++) {
      const reply = await claude(messages, 1280, 720);
      messages.push({ role: "assistant", content: reply.content });
      const uses = reply.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) break;
      const results = [];
      for (const u of uses) {
        // The toolset serves each action as its own tool (name "left_click", input {coordinate});
        // the older tool is one "computer" tool with {action, ...}; either may batch {actions: [...]}.
        const input = (u.input ?? {}) as Record<string, unknown>;
        const actions: Record<string, unknown>[] = Array.isArray(input.actions)
          ? (input.actions as Record<string, unknown>[])
          : [input.action ? input : { ...input, action: u.name }];
        const r = await (async () => {
          let last: { png?: string; error?: string } = {};
          for (const a of actions) {
            last = await act(k, session.id, a);
            if (last.error) break;
          }
          return last;
        })().catch((e: Error): { png?: string; error?: string } => ({
          error: e.message,
        }));
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          // A toolset member's result names its toolset, as the call did.
          ...(u.toolset_name ? { toolset_name: u.toolset_name } : {}),
          ...(r.error
            ? { is_error: true, content: r.error }
            : {
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: r.png,
                    },
                  },
                ],
              }),
        });
      }
      messages.push({ role: "user", content: results });
    }
    const clicks = await page.evaluate("window.clicks || 0");
    const value = await page.inputValue("#i");
    if (clicks !== 3 || value.trim().toLowerCase() !== "done")
      throw new Error(
        `after ${steps} steps: ${String(clicks)} clicks, text box ${JSON.stringify(value)} (wanted 3 and "done")`,
      );
    return `${steps} steps: 3 clicks and "done" typed, checked on the page`;
  } finally {
    await browser.close().catch(() => undefined);
    await k.stop(session.id).catch(() => undefined);
  }
}

function run(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs = 600_000,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      cmd,
      args,
      {
        env: { ...process.env, ...extraEnv },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) =>
        err
          ? reject(
              new Error(
                `${cmd} failed: ${(stderr || err.message).slice(-600)}`,
              ),
            )
          : resolve(stdout),
    ),
  );
}

const agentsDir = fileURLToPath(new URL("../../agents/", import.meta.url));

/** browser-use (Python), on a session's connectUrl, reading the test page's heading. */
export async function browserUse(k: KestrelClient): Promise<string> {
  const { session } = await k.create({
    timeout: 900_000,
    idleTimeout: 300_000,
    waitForCapacityMs: 30_000,
  });
  try {
    const out = await run(
      "uv",
      [
        "run",
        "--quiet",
        "--with",
        env.BROWSER_USE_SPEC ?? "browser-use",
        "python",
        `${agentsDir}browser_use_check.py`,
      ],
      {
        CDP_URL: session.connectUrl as string,
        TEST_PAGE_URL: need("TEST_PAGE_URL"),
        AGENT_MODEL: MODEL,
      },
    );
    const result = /RESULT: (.*)/.exec(out)?.[1] ?? "";
    const visited = (await k.events(session.id)).length;
    if (!/kestrel test page/i.test(result))
      throw new Error(
        `browser-use answered ${JSON.stringify(result.slice(0, 200))}`,
      );
    return `answered "${result.slice(0, 80)}" (${visited} session events)`;
  } finally {
    await k.stop(session.id).catch(() => undefined);
  }
}

/** Stagehand (TypeScript), attached to a session by its connectUrl, extracting the page title. */
export async function stagehand(k: KestrelClient): Promise<string> {
  const { session } = await k.create({
    timeout: 900_000,
    idleTimeout: 300_000,
    waitForCapacityMs: 30_000,
  });
  try {
    await run(
      "npm",
      [
        "install",
        "--prefix",
        `${agentsDir}stagehand`,
        "--no-audit",
        "--no-fund",
        "--silent",
      ],
      {},
    );
    const out = await run("node", [`${agentsDir}stagehand/check.mjs`], {
      CDP_URL: session.connectUrl as string,
      TEST_PAGE_URL: need("TEST_PAGE_URL"),
      AGENT_MODEL: `anthropic/${MODEL}`,
    });
    const result = /RESULT: (.*)/.exec(out)?.[1] ?? "";
    if (!/kestrel test page/i.test(result))
      throw new Error(
        `Stagehand extracted ${JSON.stringify(result.slice(0, 200))}`,
      );
    return `extracted "${result.slice(0, 80)}"`;
  } finally {
    await k.stop(session.id).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set: skipping the agent tests (they call an LLM)",
    );
    process.exit(0);
  }
  const k = new KestrelClient(need("KESTREL_URL"), need("KESTREL_API_KEY"));
  const all = {
    claude: claudeComputerUse,
    "browser-use": browserUse,
    stagehand,
  } as const;
  const pick = process.argv.slice(2).length
    ? process.argv.slice(2)
    : Object.keys(all);
  let failed = 0;
  for (const name of pick) {
    const fn = all[name as keyof typeof all];
    if (!fn) throw new Error(`unknown agent ${name}`);
    try {
      console.log(`${name}: ok, ${await fn(k)}`);
    } catch (e) {
      failed++;
      console.log(`${name}: FAILED, ${(e as Error).message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
