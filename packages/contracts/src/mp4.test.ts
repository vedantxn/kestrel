import { describe, expect, it } from "vitest";
import { checkMp4Fragment, mp4BoxHeader } from "./mp4.js";
import {
  ConfigureRequest,
  RECORDING_LIMITS,
  RecordingFragments,
} from "./runtime-control.js";

const box = (type: string, body = 0): Buffer => {
  const b = Buffer.alloc(8 + body);
  b.writeUInt32BE(8 + body, 0);
  b.write(type, 4, "latin1");
  return b;
};
const MAX = RECORDING_LIMITS.fragmentBytes;

describe("MP4 box checks (microVM recording)", () => {
  it("reads a header, a 64-bit size, and waits for more bytes when one is cut", () => {
    expect(mp4BoxHeader(box("moof", 4), 0, MAX)).toEqual({
      type: "moof",
      size: 12,
      header: 8,
    });
    const big = Buffer.alloc(24);
    big.writeUInt32BE(1, 0);
    big.write("mdat", 4, "latin1");
    big.writeBigUInt64BE(24n, 8);
    expect(mp4BoxHeader(big, 0, MAX)).toEqual({
      type: "mdat",
      size: 24,
      header: 16,
    });
    expect(mp4BoxHeader(big.subarray(0, 12), 0, MAX)).toBe("short");
    expect(mp4BoxHeader(Buffer.alloc(5), 0, MAX)).toBe("short");
  });

  it("refuses unknown types, size 0, sizes under the header and oversized boxes", () => {
    expect(mp4BoxHeader(box("evil"), 0, MAX)).toMatchObject({
      error: expect.stringContaining("unexpected box"),
    });
    const zero = box("mdat");
    zero.writeUInt32BE(0, 0);
    expect(mp4BoxHeader(zero, 0, MAX)).toMatchObject({
      error: expect.any(String),
    });
    const tiny = box("moof");
    tiny.writeUInt32BE(4, 0);
    expect(mp4BoxHeader(tiny, 0, MAX)).toMatchObject({
      error: expect.any(String),
    });
    const huge = box("mdat");
    huge.writeUInt32BE(MAX + 1, 0);
    expect(mp4BoxHeader(huge, 0, MAX)).toMatchObject({
      error: expect.stringContaining("too large"),
    });
    const wide = Buffer.alloc(16);
    wide.writeUInt32BE(1, 0);
    wide.write("mdat", 4, "latin1");
    wide.writeBigUInt64BE(2n ** 63n, 8);
    expect(mp4BoxHeader(wide, 0, MAX)).toMatchObject({
      error: expect.any(String),
    });
  });

  it("accepts whole fragments of the recorder's boxes, with ftyp only at the start", () => {
    const init = Buffer.concat([box("ftyp", 20), box("moov", 700)]);
    const frag = Buffer.concat([box("moof", 176), box("mdat", 5000)]);
    expect(checkMp4Fragment(init, true, MAX)).toEqual({
      boxes: ["ftyp", "moov"],
    });
    expect(checkMp4Fragment(frag, false, MAX)).toEqual({
      boxes: ["moof", "mdat"],
    });
    expect(checkMp4Fragment(box("mfra", 100), false, MAX)).toEqual({
      boxes: ["mfra"],
    });
    expect(checkMp4Fragment(frag, true, MAX)).toMatchObject({
      error: expect.stringContaining("ftyp"),
    });
    expect(checkMp4Fragment(init, false, MAX)).toMatchObject({
      error: expect.stringContaining("ftyp"),
    });
  });

  it("refuses a fragment that is empty, cut inside a box, or has bytes past its boxes", () => {
    const frag = Buffer.concat([box("moof", 176), box("mdat", 5000)]);
    expect(checkMp4Fragment(Buffer.alloc(0), false, MAX)).toHaveProperty(
      "error",
    );
    expect(checkMp4Fragment(frag.subarray(0, 300), false, MAX)).toHaveProperty(
      "error",
    );
    expect(
      checkMp4Fragment(Buffer.concat([frag, Buffer.from("tail")]), false, MAX),
    ).toHaveProperty("error");
    expect(
      checkMp4Fragment(Buffer.concat([frag, box("html", 10)]), false, MAX),
    ).toHaveProperty("error");
  });
});

describe("the pull sink's contract", () => {
  it("defaults the sink to the volume, so an older agent's configure means what it did", () => {
    expect(
      ConfigureRequest.parse({
        sessionProof: "ab".repeat(32),
        viewport: { width: 1280, height: 720 },
        recording: true,
      }).recordingSink,
    ).toBe("volume");
  });

  it("describes fragments strictly and caps their number and size", () => {
    const ok = {
      state: "recording",
      fragments: [{ seq: 1, bytes: 10 }],
      done: false,
    };
    expect(RecordingFragments.parse(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, state: "paused" },
      { ...ok, fragments: [{ seq: 0, bytes: 10 }] },
      { ...ok, fragments: [{ seq: 1, bytes: 0 }] },
      { ...ok, fragments: [{ seq: 1, bytes: MAX + 1 }] },
      { ...ok, fragments: [{ seq: 1, bytes: 1, path: "/etc/passwd" }] },
      {
        ...ok,
        fragments: Array.from(
          { length: RECORDING_LIMITS.pullFragments + 1 },
          (_, i) => ({ seq: i + 1, bytes: 1 }),
        ),
      },
    ])
      expect(RecordingFragments.safeParse(bad).success).toBe(false);
  });
});
