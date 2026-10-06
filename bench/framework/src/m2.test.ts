import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { decodeMp4, judgeDecoded, mp4Boxes, parseDecoded } from "./m2.js";

const box = (type: string, body = 0) => {
  const b = Buffer.alloc(8 + body);
  b.writeUInt32BE(8 + body, 0);
  b.write(type, 4, "latin1");
  return b;
};

describe("mp4Boxes", () => {
  it("lists a fragmented file's top-level boxes and stops at a truncated one", () => {
    const f = Buffer.concat([
      box("ftyp", 8),
      box("moov", 20),
      box("moof", 4),
      box("mdat", 100),
      box("moof", 4),
    ]);
    expect(mp4Boxes(f)).toEqual(["ftyp", "moov", "moof", "mdat", "moof"]);
    expect(mp4Boxes(f.subarray(0, f.length - 3))).toEqual([
      "ftyp",
      "moov",
      "moof",
      "mdat",
      "moof",
    ]);
    expect(mp4Boxes(Buffer.from("garbage!"))).toEqual([]);
  });
});

describe("judging a decoded recording (check 7)", () => {
  const probe = (frames: number, codec = "h264") =>
    JSON.stringify({
      streams: [
        {
          codec_name: codec,
          width: 1296,
          height: 806,
          nb_read_frames: String(frames),
        },
      ],
      format: { duration: String(frames / 10) },
    });

  it("passes a clean h264 recording with about the frames its seconds should have", () => {
    const d = parseDecoded(probe(580), "");
    expect(d).toMatchObject({ clean: true, frames: 580, width: 1296 });
    expect(judgeDecoded(d, 60)).toBeNull();
  });

  it("fails decode errors, another codec, too few frames, or nothing at all", () => {
    expect(judgeDecoded(parseDecoded(probe(580), "corrupt slice"), 60)).toMatch(
      /errors/,
    );
    expect(judgeDecoded(parseDecoded(probe(580, "vp9"), ""), 60)).toMatch(
      /h264/,
    );
    expect(judgeDecoded(parseDecoded(probe(300), ""), 60)).toMatch(/frames/);
    expect(judgeDecoded(parseDecoded("not json", ""), 60)).not.toBeNull();
  });
});

const ffmpeg = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!ffmpeg)(
  "decoding with a real ffmpeg (skipped where absent)",
  () => {
    const local = (tool: string, args: string[]): [string, string[]] => [
      tool,
      args,
    ];
    const make = (seconds: number) =>
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=640x360:rate=10`,
          "-t",
          String(seconds),
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "20",
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          "pipe:1",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );

    it("decodes a fragmented recording from stdin and counts its frames", async () => {
      const d = await decodeMp4(make(10), local);
      expect(d).toMatchObject({ clean: true, codec: "h264", frames: 100 });
      expect(judgeDecoded(d, 10)).toBeNull();
    });

    it("finds a recording cut short", async () => {
      const mp4 = make(10);
      const d = await decodeMp4(mp4.subarray(0, mp4.length / 3), local);
      expect(judgeDecoded(d, 10)).not.toBeNull();
    });
  },
);
