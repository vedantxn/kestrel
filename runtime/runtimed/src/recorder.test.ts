import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Recorder, recorderArgs, type Spawn } from "./recorder.js";

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
