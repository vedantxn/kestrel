/**
 * W3 in a microVM (docs/lld/microvm-recording.md). The recorder's fragmented MP4 is cut into
 * fragments at top-level box boundaries in the guest, and the node agent checks every fragment's
 * boxes before it appends it to the recording. Both ends use these helpers, so they agree on what a
 * box is. Only box headers are read: the contents (the video itself) are never parsed on the host.
 */

/** The top-level boxes a fragmented MP4 from the recorder is made of; anything else is refused. */
export const MP4_TOP_LEVEL_BOXES = [
  "ftyp",
  "moov",
  "moof",
  "mdat",
  "mfra",
  "styp",
  "sidx",
  "free",
  "skip",
] as const;
export type Mp4Box = (typeof MP4_TOP_LEVEL_BOXES)[number];

const ALLOWED: ReadonlySet<string> = new Set(MP4_TOP_LEVEL_BOXES);

/**
 * The header of the box at `off`: its type, whole size and header length. `"short"` when fewer
 * bytes than a header are there yet; an error string when the header is not one the recorder
 * writes (an unknown type, a size under the header's, the "to the end of the file" size 0, or a
 * size past `maxSize`).
 */
export function mp4BoxHeader(
  buf: Uint8Array,
  off: number,
  maxSize: number,
):
  { type: Mp4Box; size: number; header: number } | "short" | { error: string } {
  if (buf.length - off < 8) return "short";
  const view = new DataView(buf.buffer, buf.byteOffset + off);
  let size = view.getUint32(0);
  const type = String.fromCharCode(
    buf[off + 4]!,
    buf[off + 5]!,
    buf[off + 6]!,
    buf[off + 7]!,
  );
  let header = 8;
  if (size === 1) {
    if (buf.length - off < 16) return "short";
    const big = view.getBigUint64(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER))
      return { error: "box size out of range" };
    size = Number(big);
    header = 16;
  }
  if (!ALLOWED.has(type))
    return { error: `unexpected box ${JSON.stringify(type)}` };
  if (size === 0) return { error: "box without a size" };
  if (size < header) return { error: `${type} box smaller than its header` };
  if (size > maxSize)
    return { error: `${type} box of ${size} bytes is too large` };
  return { type: type as Mp4Box, size, header };
}

/**
 * Check that `buf` is exactly a sequence of whole top-level boxes of the recorder's kinds, each at
 * most `maxSize` bytes. The first fragment of a recording must start with `ftyp`. Returns the
 * boxes' types, or an error.
 */
export function checkMp4Fragment(
  buf: Uint8Array,
  first: boolean,
  maxSize: number,
): { boxes: Mp4Box[] } | { error: string } {
  if (buf.length === 0) return { error: "empty fragment" };
  const boxes: Mp4Box[] = [];
  let off = 0;
  while (off < buf.length) {
    const h = mp4BoxHeader(buf, off, maxSize);
    if (h === "short") return { error: "fragment ends inside a box header" };
    if ("error" in h) return h;
    if (off + h.size > buf.length)
      return { error: `fragment ends inside a ${h.type} box` };
    boxes.push(h.type);
    off += h.size;
  }
  if (first && boxes[0] !== "ftyp")
    return { error: "a recording must start with ftyp" };
  if (!first && boxes.includes("ftyp"))
    return { error: "ftyp after the start of a recording" };
  return { boxes };
}
