import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pipeClock } from "./clock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fifo(): string {
  const d = mkdtempSync(join(tmpdir(), "clock-"));
  dirs.push(d);
  const p = join(d, "clock");
  execFileSync("mkfifo", ["-m", "0600", p]);
  return p;
}

/** A guest clock behind the host by `lagMs`, which "init" corrects when it reads the pipe. */
function guest(path: string, lagMs: number) {
  let offset = -lagMs;
  let mono = 0;
  const lines: string[] = [];
  const reader = createReadStream(path, { encoding: "utf8" });
  reader.on("data", (chunk: string | Buffer) => {
    const t = String(chunk).trim();
    lines.push(t);
    offset = Number(t) * 1000 - (HOST_START + mono); // set the clock as init does
  });
  return {
    lines,
    now: () => HOST_START + mono + offset,
    monotonic: () => (mono += 5),
    close: () => reader.destroy(),
  };
}
const HOST_START = 1_791_369_000_000;

describe("a clone's clock (threat model 9.1)", () => {
  it("hands the host's time to init through the pipe and waits until the guest's clock agrees", async () => {
    const p = fifo();
    const g = guest(p, 630_000);
    await new Promise((r) => setTimeout(r, 20)); // init is reading
    const c = pipeClock(p, { now: g.now, monotonic: g.monotonic });
    expect(await c.set(HOST_START)).toBe(true);
    expect(g.lines).toEqual([(HOST_START / 1000).toFixed(3)]);
    g.close();
  });

  it("answers false at once when nothing reads the pipe, rather than hang the rekey", async () => {
    const p = fifo();
    const t0 = Date.now();
    expect(await pipeClock(p).set(HOST_START)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("answers false when the guest's clock never comes right", async () => {
    const p = fifo();
    const reader = createReadStream(p); // reads, but nothing sets the clock
    await new Promise((r) => setTimeout(r, 20));
    let mono = 0;
    const c = pipeClock(p, {
      now: () => HOST_START - 630_000,
      monotonic: () => (mono += 50),
      waitMs: 200,
    });
    expect(await c.set(HOST_START)).toBe(false);
    reader.destroy();
  });

  it("answers false when there is no pipe at all (a container, or an old guest)", async () => {
    expect(await pipeClock("/nonexistent/clock").set(HOST_START)).toBe(false);
  });
});
