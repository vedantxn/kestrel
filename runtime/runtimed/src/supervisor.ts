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
  private procs: Proc[] = [];

  constructor(
    private readonly cfg: Env,
    private readonly spawn: SpawnFn,
    private readonly onFatal: (why: string) => void,
    private readonly displaySocket = `/tmp/.X11-unix/X${cfg.DISPLAY_NUM.replace(/^:/, "")}`,
    private readonly timeouts = {
      displayMs: 10_000,
      chromeMs: 30_000,
      pollMs: 100,
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
    if (this.state === "starting") this.state = "ready";
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
