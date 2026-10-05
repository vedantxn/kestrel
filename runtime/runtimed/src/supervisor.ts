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

export type State = "starting" | "ready" | "failed";

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

  async start(): Promise<void> {
    const watch = (name: string, p: Proc): void => {
      this.procs.push(p);
      p.on("exit", (code, signal) =>
        this.fail(`${name} exited (${code ?? signal})`),
      );
    };

    watch(
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

    watch(
      "Chrome",
      this.spawn(this.cfg.CHROME_PATH, chromeArgs(this.cfg), {
        DISPLAY: this.cfg.DISPLAY_NUM,
        HOME: "/home/kestrel",
      }),
    );
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
    if (this.prepare) await this.prepare().catch(() => undefined);
    if (this.state === "starting") this.state = "ready";
    this.wake();
  }

  /** Resolves once the browser is ready or failed, or after `ms`, whichever is first. */
  async settle(ms: number): Promise<void> {
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
