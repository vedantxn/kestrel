import { mkdtempSync, readFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_LIMITS, encodeProfileArchive } from "@kestrel/contracts";
import { describe, expect, it, vi } from "vitest";
import { restoreProfileArchive } from "./profile.js";

/*
 * A write may take fewer bytes than it was given (a full pipe, a signal, some filesystems). Here
 * every write the profile module makes takes at most 3 bytes, and the files must still be whole.
 */
const short = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const fh = await fs.open(...args);
      if (!short.on) return fh;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "write")
            return (buf: Uint8Array, off = 0, len = buf.length - off) =>
              target.write(buf, off, Math.min(len, 3));
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as FileHandle;
    },
  };
});

async function* chunks(b: Buffer, size = 64): AsyncIterable<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

describe("restore with short writes", () => {
  it("writes every file whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prof-short-"));
    const files = [
      {
        path: "Default/LocalStorage",
        data: Buffer.from("local storage, more than three bytes"),
      },
      {
        path: "Default/IndexedDB/https_a_0.indexeddb.leveldb/000003.log",
        data: Buffer.alloc(1000, 7),
      },
    ];
    short.on = true;
    try {
      await restoreProfileArchive(
        dir,
        chunks(encodeProfileArchive([], files)),
        PROFILE_LIMITS.maxBytes,
      );
    } finally {
      short.on = false;
    }
    for (const f of files)
      expect(readFileSync(join(dir, f.path))).toEqual(f.data);
  });
});
