import { describe, expect, it } from "vitest";
import { mp4Boxes } from "./m2.js";

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
