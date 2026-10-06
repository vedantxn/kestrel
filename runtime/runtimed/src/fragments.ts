import { mp4BoxHeader } from "@kestrel/contracts";

/**
 * The pull sink (docs/lld/microvm-recording.md). A microVM has no recording volume: ffmpeg writes
 * its fragmented MP4 to a pipe, this cuts the stream into fragments at top-level box boundaries
 * (the init segment `ftyp`+`moov`, then each `moof`+`mdat`, then `mfra` at the end), and holds
 * them in memory until the node agent pulls them over the control API. Asking for the fragments
 * after N acknowledges everything up to N, which is then freed.
 *
 * Memory is bounded. Past `maxBuffered` bytes held, the stream is paused: ffmpeg blocks on the
 * full pipe and x11grab captures nothing until it drains, so a slow agent costs frames (the video
 * holds its last picture), never the guest's memory. While the recorder stops the bound is raised
 * by two fragments, so ffmpeg can always flush its last one.
 */
export interface Fragment {
  seq: number;
  data: Buffer;
}

/** The boxes that end a fragment: the init segment, a media fragment, and the closing index. */
const CLOSES = new Set(["moov", "mdat", "mfra"]);

export class FragmentQueue {
  private queue: Fragment[] = [];
  private queuedBytes = 0;
  private nextSeq = 1;
  private acked = 0;
  /** Bytes read but not yet a whole box. */
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  /** Whole boxes of the fragment being built. */
  private open: Buffer[] = [];
  private openBytes = 0;
  private paused = false;
  /** The stream has ended (the recorder exited): nothing more will be queued. */
  ended = false;
  /** Why the stream was abandoned, if it was. */
  failed: string | null = null;
  /** Raised while the recorder stops, so its last fragment always fits. */
  stopping = false;

  constructor(
    private readonly o: {
      maxFragment: number;
      maxBuffered: number;
      pause(): void;
      resume(): void;
      onError(why: string): void;
    },
  ) {}

  /** Bytes held: queued fragments, the one being built and unparsed input. */
  get held(): number {
    return this.queuedBytes + this.openBytes + this.chunkBytes;
  }

  push(chunk: Buffer): void {
    if (this.ended || this.failed) return;
    this.chunks.push(chunk);
    this.chunkBytes += chunk.length;
    for (;;) {
      const h = mp4BoxHeader(this.peek(16), 0, this.o.maxFragment);
      if (h === "short") break;
      if ("error" in h) return this.fail(h.error);
      if (this.openBytes + h.size > this.o.maxFragment)
        return this.fail("a fragment is too large");
      if (this.chunkBytes < h.size) break;
      this.open.push(this.shift(h.size));
      this.openBytes += h.size;
      if (CLOSES.has(h.type)) {
        const data = Buffer.concat(this.open, this.openBytes);
        this.open = [];
        this.openBytes = 0;
        this.queue.push({ seq: this.nextSeq++, data });
        this.queuedBytes += data.length;
      }
    }
    this.check();
  }

  /** The stream ended. A fragment cut off by a kill is dropped: the file plays up to the one before. */
  end(): void {
    this.ended = true;
    this.chunks = [];
    this.chunkBytes = 0;
    this.open = [];
    this.openBytes = 0;
    this.check();
  }

  /**
   * Acknowledge fragments up to `after` and return the next ones, at most `maxBytes` and
   * `maxCount` (always at least one if there is one). `done`: the stream has ended and nothing
   * is left after these. Throws if `after` names fragments already freed or never made.
   */
  take(
    after: number,
    maxBytes: number,
    maxCount: number,
  ): { fragments: Fragment[]; done: boolean } {
    if (after < this.acked)
      throw new Error(
        `fragments up to ${this.acked} were already acknowledged`,
      );
    if (after >= this.nextSeq)
      throw new Error(`no fragment ${after} has been made`);
    this.acked = after;
    while (this.queue.length && this.queue[0]!.seq <= after)
      this.queuedBytes -= this.queue.shift()!.data.length;
    const out: Fragment[] = [];
    let bytes = 0;
    for (const f of this.queue) {
      if (out.length >= maxCount) break;
      if (out.length > 0 && bytes + f.data.length > maxBytes) break;
      out.push(f);
      bytes += f.data.length;
    }
    this.check();
    return {
      fragments: out,
      done: this.ended && out.length === this.queue.length,
    };
  }

  private fail(why: string): void {
    this.failed = why;
    this.chunks = [];
    this.chunkBytes = 0;
    this.open = [];
    this.openBytes = 0;
    this.check();
    this.o.onError(why);
  }

  private check(): void {
    const limit =
      this.o.maxBuffered + (this.stopping ? 2 * this.o.maxFragment : 0);
    const full = !this.ended && !this.failed && this.held >= limit;
    if (full && !this.paused) {
      this.paused = true;
      this.o.pause();
    } else if (!full && this.paused) {
      this.paused = false;
      this.o.resume();
    }
  }

  /** Raise the bound while the recorder finishes. */
  stop(): void {
    this.stopping = true;
    this.check();
  }

  private peek(n: number): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks[0]!.length >= n) return this.chunks[0]!.subarray(0, n);
    const parts: Buffer[] = [];
    let have = 0;
    for (const c of this.chunks) {
      if (have >= n) break;
      parts.push(c);
      have += c.length;
    }
    return Buffer.concat(parts).subarray(0, n);
  }

  private shift(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const c = this.chunks[0]!;
      if (c.length <= need) {
        parts.push(c);
        this.chunks.shift();
        need -= c.length;
      } else {
        parts.push(c.subarray(0, need));
        this.chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    this.chunkBytes -= n;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n);
  }
}
