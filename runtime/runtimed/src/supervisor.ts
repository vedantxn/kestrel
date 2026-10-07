import { existsSync } from "node:fs";
import type { Env } from "./config.js";
import { chromeArgs } from "./chrome-args.js";
import { getVersion } from "./cdp.js";

export interface Proc {
  on(
    event: "exit",
    cb: (code: number | null, signal: string | null) => void,
  ): void;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnFn = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
) => Proc;

/**
 * `warm`: the display is up and Chrome waits for `launch()` (KESTREL_CHROME=deferred, P18).
 * `closed`: Chrome was closed on purpose, for a profile save; the browser serves nothing more.
 */
export type State = "starting" | "warm" | "ready" | "closed" | "failed";

/**
 * R4-R6. Starts the virtual display, then Chrome; the container is healthy only when Chrome's
 * debugging port answers ("hot" must mean truly ready). If Chrome or the display dies, the
 * container stops: nothing is restarted in place, a browser is used once.
 */
export class Supervisor {
  state: State = "starting";
  chromeVersion: string | null = null;
  /**
   * Work to finish once Chrome answers and before the browser counts as ready: sizing the window
   * to the default viewport, so a session start does not pay for it. Its failure does not fail the
   * browser; configure sizes the window anyway.
   */
  prepare: (() => Promise<unknown>) | undefined;
  private procs: Proc[] = [];
  private settled = new Set<() => void>();
  private chrome: Proc | undefined;
  /** Set while Chrome is being closed for a save: its exit is then expected, not fatal. */
  private closing: { exited: Promise<void>; done: () => void } | undefined;

  constructor(
    private readonly cfg: Env,
    private readonly spawn: SpawnFn,
    private readonly onFatal: (why: string) => void,
    private readonly displaySocket = `/tmp/.X11-unix/X${cfg.DISPLAY_NUM.replace(/^:/, "")}`,
    private readonly timeouts = {
      displayMs: 10_000,
      chromeMs: 30_000,
      // Both checks are local and cheap (a stat, a refused connection); a coarse poll only added
      // up to its period to every cold start, twice.
      pollMs: 10,
    },
  ) {}

  get chromeReady(): boolean {
    return this.state === "ready";
  }

  /** The state as the health contract names it: a browser closed for a save serves nothing. */
  get health(): "starting" | "warm" | "ready" | "failed" {
    return this.state === "closed" ? "failed" : this.state;
  }

  private watch(name: string, p: Proc): void {
    this.procs.push(p);
    p.on("exit", (code, signal) => {
      if (p === this.chrome && this.closing) return this.closing.done();
      this.fail(`${name} exited (${code ?? signal})`);
    });
  }

  async start(): Promise<void> {
    this.watch(
      "Xvfb",
      this.spawn(
        this.cfg.XVFB_PATH,
        [
          this.cfg.DISPLAY_NUM,
          "-screen",
          "0",
          this.cfg.SCREEN,
          "-nolisten",
          "tcp",
          "-noreset",
        ],
        {},
      ),
    );
    if (
      !(await this.until(
        () => existsSync(this.displaySocket),
        this.timeouts.displayMs,
      ))
    )
      return this.fail("the display did not start");

    // A warm browser: Chrome waits for a profile and `launch()`.
    if (this.cfg.KESTREL_CHROME === "deferred") {
      if (this.state === "starting") this.state = "warm";
      this.wake();
      return;
    }
    await this.startChrome(undefined, true);
  }

  /**
   * P18: start Chrome in a warm browser, at the session's window size. The arguments are the same
   * as any browser's but for the size, so a profile session cannot be told apart by its flags.
   * Resolves once Chrome is ready or the browser has failed.
   */
  async launch(size: { width: number; height: number }): Promise<void> {
    if (this.state !== "warm")
      throw new Error(`cannot launch when ${this.state}`);
    this.state = "starting";
    await this.startChrome(size, false);
  }

  private async startChrome(
    size: { width: number; height: number } | undefined,
    prepare: boolean,
  ): Promise<void> {
    this.chrome = this.spawn(this.cfg.CHROME_PATH, chromeArgs(this.cfg, size), {
      DISPLAY: this.cfg.DISPLAY_NUM,
      HOME: "/home/kestrel",
    });
    this.watch("Chrome", this.chrome);
    let version: string | null = null;
    const ready = await this.until(async () => {
      try {
        version = (await getVersion(this.cfg.CHROME_PORT)).browser;
        return true;
      } catch {
        return false;
      }
    }, this.timeouts.chromeMs);
    if (!ready) return this.fail("Chrome did not become ready");
    this.chromeVersion = version;
    if (prepare && this.prepare) await this.prepare().catch(() => undefined);
    if (this.state === "starting") this.state = "ready";
    this.wake();
  }

  /**
   * P18: close Chrome on purpose, for a profile save. `ask` asks it to close (`Browser.close`);
   * its exit is then expected rather than fatal. If it has not exited within `ms`, it is killed and
   * the answer is `killed`: its files may be torn, and are not saved.
   */
  async closeChrome(
    ask: () => Promise<unknown>,
    ms: number,
  ): Promise<"exited" | "killed"> {
    if (this.state !== "ready" || !this.chrome)
      throw new Error(`cannot close Chrome when ${this.state}`);
    let done!: () => void;
    const exited = new Promise<void>((r) => (done = r));
    this.closing = { exited, done };
    this.state = "closed";
    await ask().catch(() => undefined); // the connection may drop as Chrome goes
    let timer: NodeJS.Timeout | undefined;
    const inTime = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
    ]);
    clearTimeout(timer);
    if (inTime) return "exited";
    try {
      this.chrome.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return "killed";
  }

  /** Resolves once the browser is ready or failed, or after `ms`, whichever is first. */
  async settle(ms: number): Promise<void> {
    // A warm browser has settled too: it waits for `launch()`.
    if (this.state !== "starting" || ms <= 0) return;
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    this.settled.add(done);
    const t = setTimeout(done, ms);
    await p;
    clearTimeout(t);
    this.settled.delete(done);
  }

  private wake(): void {
    for (const w of this.settled) w();
  }

  private async until(
    cond: () => boolean | Promise<boolean>,
    ms: number,
  ): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.state === "failed") return false;
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, this.timeouts.pollMs));
    }
    return false;
  }

  private fail(why: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.wake();
    for (const p of this.procs) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.onFatal(why);
  }
}
