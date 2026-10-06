import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Recorder, recorderArgs, type Spawn } from "./recorder.js";
import { box, stream } from "./test/mp4.js";

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  written = "";
  killed: string | null = null;
  constructor(exitOnQ = true) {
    super();
    this.stdin.on("data", (d) => {
      this.written += d.toString();
      if (exitOnQ && this.written.includes("q"))
        setImmediate(() => this.emit("exit", 0, null));
    });
  }
  kill(sig: string) {
    this.killed = sig;
    setImmediate(() => this.emit("exit", null, sig));
  }
}

describe("the recorder (W3)", () => {
  it("captures the window region as fragmented MP4, with even dimensions and a size limit", () => {
    const a = recorderArgs({
      display: ":99",
      width: 1281,
      height: 801,
      out: "/artifacts/recording.mp4",
    });
    expect(a.join(" ")).toContain("-video_size 1280x800 -i :99.0+0,0");
    expect(a.join(" ")).toContain("frag_keyframe+empty_moov+default_base_moof");
    expect(a).toContain("-fs");
    expect(a.at(-1)).toBe("/artifacts/recording.mp4");
  });

  it("does not start without a writable directory (no volume was mounted)", () => {
    let spawned = 0;
    const r = new Recorder(
      "/nonexistent-dir",
      ":99",
      (() => (spawned++, new FakeProc())) as unknown as Spawn,
    );
    expect(r.start({ width: 800, height: 600 })).toBe(false);
    expect(spawned).toBe(0);
  });

  it("stops by asking ffmpeg to finish, and only kills it if it will not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const polite = new FakeProc();
    const r = new Recorder(dir, ":99", (() => polite) as unknown as Spawn);
    expect(r.start({ width: 800, height: 600 })).toBe(true);
    expect(r.state).toBe("recording");
    await r.stop();
    expect(polite.written).toBe("q");
    expect(polite.killed).toBeNull();
    expect(r.state).toBe("stopped");

    const stubborn = new FakeProc(false);
    const r2 = new Recorder(dir, ":99", (() => stubborn) as unknown as Spawn);
    r2.start({ width: 800, height: 600 });
    await r2.stop(50);
    expect(stubborn.killed).toBe("SIGKILL");
  });

  it("notes a recorder that died by itself, without taking the session down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const p = new FakeProc();
    const r = new Recorder(dir, ":99", (() => p) as unknown as Spawn);
    r.start({ width: 800, height: 600 });
    p.emit("exit", 1, null);
    expect(r.state).toBe("failed");
    await r.stop(); // nothing to stop
  });
});

class PipedProc extends FakeProc {
  stdout = new PassThrough();
  constructor() {
    super(false);
    // Asked to finish, ffmpeg ends its stream, then exits.
    this.stdin.on("data", () =>
      setImmediate(() => {
        this.stdout.end();
        this.emit("exit", 0, null);
      }),
    );
  }
  override kill(sig: string) {
    this.killed = sig;
    this.stdout.end();
    setImmediate(() => this.emit("exit", null, sig));
  }
}

const tick = () => new Promise((res) => setImmediate(res));

describe("the recorder's pull sink (microVM)", () => {
  it("writes to a pipe, cut at 4 MiB as well as at keyframes", () => {
    const a = recorderArgs({
      display: ":99",
      width: 1280,
      height: 720,
      out: "pipe:1",
    });
    expect(a.join(" ")).toContain("-frag_size 4194304");
    expect(a.at(-1)).toBe("pipe:1");
    expect(
      recorderArgs({ display: ":99", width: 2, height: 2, out: "/a/b.mp4" }),
    ).not.toContain("-frag_size");
  });

  it("needs no volume, reads ffmpeg's output into fragments, and ends them when ffmpeg stops", async () => {
    const p = new PipedProc();
    let piped: boolean | undefined;
    const r = new Recorder(
      "/nonexistent-dir",
      ":99",
      ((_c: string, _a: string[], pipe: boolean) => (
        (piped = pipe),
        p
      )) as unknown as Spawn,
    );
    expect(r.fragments).toBeNull();
    expect(r.start({ width: 800, height: 600 }, "pull")).toBe(true);
    expect(piped).toBe(true);
    p.stdout.write(stream(2));
    await tick();
    // init, two media fragments, the index
    expect(r.fragments!.take(0, 1e9, 64).fragments).toHaveLength(4);
    await r.stop();
    await tick();
    expect(r.state).toBe("stopped");
    expect(r.fragments!.take(4, 1e9, 64)).toEqual({
      fragments: [],
      done: true,
    });
  });

  it("kills ffmpeg if what it writes is not the recorder's MP4, keeping the whole fragments", async () => {
    const p = new PipedProc();
    const r = new Recorder(
      "/nonexistent-dir",
      ":99",
      (() => p) as unknown as Spawn,
    );
    r.start({ width: 800, height: 600 }, "pull");
    p.stdout.write(Buffer.concat([stream(1).subarray(0, -58), box("evil", 4)]));
    await tick();
    expect(p.killed).toBe("SIGKILL");
    expect(r.state).toBe("failed");
    expect(r.fragments!.take(0, 1e9, 64).fragments).toHaveLength(2);
  });
});
