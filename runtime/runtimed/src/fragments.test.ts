import { execFileSync, spawn } from "node:child_process";
import { checkMp4Fragment, RECORDING_LIMITS } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import { FragmentQueue } from "./fragments.js";
import { recorderArgs } from "./recorder.js";
import { box, stream } from "./test/mp4.js";

function queue(
  over: Partial<{ maxFragment: number; maxBuffered: number }> = {},
) {
  const events: string[] = [];
  const q = new FragmentQueue({
    maxFragment: over.maxFragment ?? RECORDING_LIMITS.fragmentBytes,
    maxBuffered: over.maxBuffered ?? RECORDING_LIMITS.guestBufferBytes,
    pause: () => events.push("pause"),
    resume: () => events.push("resume"),
    onError: (why) => events.push(`error: ${why}`),
  });
  return { q, events };
}

const feed = (q: FragmentQueue, b: Buffer, step: number) => {
  for (let i = 0; i < b.length; i += step) q.push(b.subarray(i, i + step));
};

describe("the pull sink's fragments (microVM recording)", () => {
  it("cuts the stream at box boundaries however it arrives: init, each moof+mdat, the index", () => {
    for (const step of [1, 7, 64, 100_000]) {
      const { q } = queue();
      const s = stream(3);
      feed(q, s, step);
      q.end();
      const { fragments, done } = q.take(0, 1e9, 64);
      expect(done).toBe(true);
      expect(fragments.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(Buffer.concat(fragments.map((f) => f.data))).toEqual(s);
      fragments.forEach((f, i) =>
        expect(
          checkMp4Fragment(f.data, i === 0, RECORDING_LIMITS.fragmentBytes),
        ).toHaveProperty("boxes"),
      );
    }
  });

  it("frees what the agent acknowledges, and refuses to go back or ahead", () => {
    const { q } = queue();
    q.push(stream(4));
    expect(q.take(0, 1e9, 2).fragments.map((f) => f.seq)).toEqual([1, 2]);
    const held = q.held;
    expect(q.take(2, 1e9, 64).fragments.map((f) => f.seq)).toEqual([
      3, 4, 5, 6,
    ]);
    expect(q.held).toBeLessThan(held);
    expect(() => q.take(1, 1e9, 64)).toThrow(/already acknowledged/);
    expect(() => q.take(99, 1e9, 64)).toThrow(/no fragment 99/);
    // Not done until the stream ends: the index is not written until then.
    expect(q.take(6, 1e9, 64)).toEqual({ fragments: [], done: false });
  });

  it("answers within a byte budget, but always with at least one fragment", () => {
    const { q } = queue();
    q.push(stream(3, 5000));
    expect(q.take(0, 10, 64).fragments.map((f) => f.seq)).toEqual([1]);
    expect(q.take(1, 6000, 64).fragments.map((f) => f.seq)).toEqual([2]);
  });

  it("drops a fragment cut off by a kill: the recording ends at the one before", () => {
    const { q } = queue();
    const s = stream(2);
    q.push(s.subarray(0, s.length - 300));
    q.end();
    const { fragments, done } = q.take(0, 1e9, 64);
    expect(fragments.map((f) => f.seq)).toEqual([1, 2]);
    expect(done).toBe(true);
    expect(q.take(2, 1e9, 64)).toEqual({ fragments: [], done: true });
    expect(q.held).toBe(0);
  });

  it("pauses the encoder past its buffer and resumes once the agent drains it (no unbounded memory)", () => {
    const { q, events } = queue({ maxBuffered: 3000, maxFragment: 2000 });
    q.push(stream(5, 900));
    expect(events).toEqual(["pause"]);
    q.take(0, 1e9, 64);
    expect(events).toEqual(["pause"]);
    q.take(6, 1e9, 64);
    expect(events).toEqual(["pause", "resume"]);
  });

  it("makes room for the last fragment while the recorder stops", () => {
    const { q, events } = queue({ maxBuffered: 3000, maxFragment: 2000 });
    q.push(stream(5, 900));
    expect(events).toEqual(["pause"]);
    q.stop();
    expect(events).toEqual(["pause", "resume"]);
  });

  it("abandons a stream that is not the recorder's: an unknown box, no size, or one too large", () => {
    for (const bad of [
      Buffer.concat([box("ftyp", 20), box("evil", 10)]),
      Buffer.concat([
        box("ftyp", 20),
        Buffer.from([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74]),
      ]),
      Buffer.concat([box("ftyp", 20), box("mdat", 3000)]),
      Buffer.concat([box("moof", 1500), box("mdat", 1000)]),
    ]) {
      const { q, events } = queue({ maxFragment: 2000 });
      q.push(bad);
      expect(events.at(-1)).toMatch(/^error: /);
      expect(q.failed).not.toBeNull();
      q.push(stream(1)); // ignored from then on
      expect(q.take(0, 1e9, 64).fragments).toEqual([]);
    }
  });
});

const ffmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!ffmpeg)(
  "with a real ffmpeg (skipped where it is not installed)",
  () => {
    it("splits ffmpeg's piped output into fragments the agent accepts, which play back whole", async () => {
      // The recorder's own arguments, with a test pattern in place of the display.
      const args = recorderArgs({
        display: ":99",
        width: 1280,
        height: 720,
        out: "pipe:1",
      });
      const i = args.indexOf("x11grab");
      args.splice(i - 1, 2, "-f", "lavfi");
      const at = args.indexOf(":99.0+0,0");
      args[at] = "testsrc2=size=1280x720:rate=10";
      args.splice(args.indexOf("-video_size"), 2);
      args.splice(args.indexOf("-draw_mouse"), 2);
      args.splice(args.indexOf("-framerate"), 2);
      args.splice(args.indexOf("-y"), 0, "-t", "9");
      const { q } = queue();
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "inherit"] });
      p.stdout.on("data", (c: Buffer) => q.push(c));
      await new Promise((r) => p.stdout.once("end", r));
      q.end();
      const { fragments, done } = q.take(0, 1e9, 64);
      expect(done).toBe(true);
      expect(fragments.length).toBeGreaterThanOrEqual(6); // init, 5 x 2 s, index
      fragments.forEach((f, n) =>
        expect(
          checkMp4Fragment(f.data, n === 0, RECORDING_LIMITS.fragmentBytes),
        ).toHaveProperty("boxes"),
      );
      const file = Buffer.concat(fragments.map((f) => f.data));
      const probe = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_read_frames,width,height",
          "-of",
          "json",
          "-i",
          "pipe:0",
        ],
        { input: file },
      ).toString();
      const s = (
        JSON.parse(probe) as {
          streams: { nb_read_frames: string; width: number }[];
        }
      ).streams[0]!;
      expect(s.width).toBe(1280);
      expect(Number(s.nb_read_frames)).toBe(90);
    });
  },
);
