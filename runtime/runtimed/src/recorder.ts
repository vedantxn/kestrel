import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { RECORDING_FILE, RECORDING_LIMITS } from "@kestrel/contracts";

/**
 * W3. Records the virtual display to fragmented MP4 with ffmpeg. Fragmented, so a file cut off by
 * a crash or a kill is still playable up to its last fragment (one every two seconds). The
 * recorder is not essential: if ffmpeg dies the session carries on, unrecorded from then on.
 *
 * It records only Chrome's window, which sits at the top-left of the display (R3), so the video
 * is the size of the window rather than the whole 1920x1080 screen.
 */
export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export function recorderArgs(o: {
  display: string;
  width: number;
  height: number;
  out: string;
}): string[] {
  const even = (n: number) => Math.max(2, n - (n % 2)); // x264 needs even dimensions
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-framerate",
    String(RECORDING_LIMITS.framerate),
    "-video_size",
    `${even(o.width)}x${even(o.height)}`,
    "-i",
    `${o.display}.0+0,0`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    // A keyframe, and so a fragment, every two seconds.
    "-g",
    String(RECORDING_LIMITS.framerate * 2),
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-fs",
    String(RECORDING_LIMITS.fileBytes),
    "-f",
    "mp4",
    "-y",
    o.out,
  ];
}

export class Recorder {
  private proc: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  state: "idle" | "recording" | "stopped" | "failed" = "idle";

  constructor(
    private readonly dir: string,
    private readonly display: string,
    private readonly run: Spawn = (cmd, args) =>
      spawn(cmd, args, { stdio: ["pipe", "ignore", "inherit"] }),
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly ffmpeg = "ffmpeg",
  ) {}

  /**
   * Whether this container has somewhere to record to. The directory exists in the image on the
   * read-only root, so it is writable only when the agent mounted a recording volume over it.
   */
  get available(): boolean {
    try {
      accessSync(this.dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  start(window: { width: number; height: number }): boolean {
    if (this.state !== "idle" || !this.available) return false;
    const p = this.run(
      this.ffmpeg,
      recorderArgs({
        display: this.display,
        width: Math.min(window.width, 1920),
        height: Math.min(window.height, 1080),
        out: join(this.dir, RECORDING_FILE),
      }),
    );
    this.proc = p;
    this.state = "recording";
    this.exited = new Promise((resolve) => {
      p.once("exit", (code, signal) => {
        if (this.state === "recording") {
          this.state = "failed";
          this.log("the recorder stopped by itself", { code, signal });
        }
        this.proc = null;
        resolve();
      });
      p.once("error", (e) => {
        this.state = "failed";
        this.log("the recorder could not start", { err: e.message });
        this.proc = null;
        resolve();
      });
    });
    return true;
  }

  /** Ask ffmpeg to finish its last fragment ("q" on stdin), then insist. */
  async stop(graceMs = 3000): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.state = "stopped";
    try {
      p.stdin?.end("q");
    } catch {
      /* already closing */
    }
    const done = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!done) {
      p.kill("SIGKILL");
      await this.exited;
    }
  }
}
