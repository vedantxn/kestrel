/** Test helpers: MP4 boxes and a recorder-shaped stream, without ffmpeg. */
export const box = (type: string, body = 0, fill = 0): Buffer => {
  const b = Buffer.alloc(8 + body, fill);
  b.writeUInt32BE(8 + body, 0);
  b.write(type, 4, "latin1");
  return b;
};

/** A recorder's stream: init segment, `n` media fragments, the closing index. */
export const stream = (n: number, body = 1000): Buffer =>
  Buffer.concat([
    box("ftyp", 20),
    box("moov", 700),
    ...Array.from({ length: n }, (_, i) => [
      box("moof", 100),
      box("mdat", body, i + 1),
    ]).flat(),
    box("mfra", 50),
  ]);
