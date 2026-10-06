import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  RECORDING_FILE,
  RECORDING_LIMITS,
  checkMp4Fragment,
  type RecordingFragments,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import type { Volumes } from "./docker.js";
import { RuntimeHttpError, type RuntimeClient } from "./runtime-client.js";
import type { PullCursor, Store } from "./store.js";

/**
 * W3 in a microVM (docs/lld/microvm-recording.md). A VM has no recording volume: its recorder
 * keeps fragmented-MP4 fragments in guest memory, and the agent pulls them over the control API
 * and appends them to the session's recording volume, the same size-limited Docker volume and file
 * a container's recording uses. Reading it back (`openRecording`), retention and reaping are then
 * the same as for a container, and the recording outlives the VM.
 *
 * Everything the guest sends is hostile (principle 2). The guest never names a path: the agent
 * picks the file. Each answer is schema-checked and capped (`RuntimeClient.recordingFragments`);
 * here its fragments must follow on from the cursor, and each must be whole boxes of the kinds the
 * recorder writes. The recording stops growing at the volume's limit. Anything else ends the
 * pulling for that session, keeping what was appended before.
 *
 * Crash-safe: the cursor (last fragment, file length) is in the store, moved by a conditional
 * update after the bytes are written and synced. A crash between the two leaves bytes past the
 * cursor, which the next pull truncates; the guest still holds those fragments, because it frees
 * only what a later request acknowledges.
 */
export type PullResult = "more" | "idle" | "done" | "error";

export interface PullDeps {
  runtime: RuntimeClient;
  store: Store;
  volumes: Volumes;
  log: Logger;
}

export class RecordingPuller {
  private running = new Map<string, Promise<PullResult>>();

  constructor(private readonly d: PullDeps) {}

  /** A pull for this session is in flight. */
  busy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /**
   * One request: append what the guest has after the cursor. Serialized per session. "more": it
   * may have more; "idle": nothing yet; "done": nothing more will be pulled; "error": the guest
   * could not be asked (try again later, or give up at teardown).
   */
  pull(
    sessionId: string,
    address: string,
    token: string,
    timeoutMs = 5000,
  ): Promise<PullResult> {
    const prev = this.running.get(sessionId) ?? Promise.resolve("idle");
    const p = prev
      .catch(() => "error" as const)
      .then(() => this.pullOnce(sessionId, address, token, timeoutMs))
      .catch((e: unknown) => {
        this.d.log.warn(
          {
            session: sessionId,
            err: e instanceof Error ? e.message : String(e),
          },
          "recording: pull failed",
        );
        return "error" as const;
      });
    this.running.set(sessionId, p);
    void p.finally(() => {
      if (this.running.get(sessionId) === p) this.running.delete(sessionId);
    });
    return p;
  }

  /**
   * At the end of a session, before its VM is removed: pull what is waiting (so the guest has room
   * to flush), stop the recorder, then pull the rest, all within `budgetMs`. A guest that is dead,
   * slow or never says it is done costs at most the budget. The recording is finished either way.
   */
  async finish(
    sessionId: string,
    address: string,
    token: string,
    stopRecorder: () => Promise<unknown>,
    budgetMs: number,
  ): Promise<void> {
    const until = performance.now() + budgetMs;
    const left = () => Math.floor(until - performance.now());
    const cursor = this.d.store.getPull(sessionId);
    let r: PullResult = cursor && !cursor.done ? "more" : "done";
    while (r === "more" && left() > 0)
      r = await this.pull(sessionId, address, token, Math.min(5000, left()));
    if (r !== "error") await stopRecorder().catch(() => undefined);
    while ((r === "more" || r === "idle") && left() > 0) {
      if (r === "idle") await new Promise((res) => setTimeout(res, 50));
      r = await this.pull(sessionId, address, token, Math.min(5000, left()));
    }
    const end = this.d.store.getPull(sessionId);
    if (end && !end.done) {
      this.d.store.finishPull(sessionId);
      this.d.log.info(
        { session: sessionId, last: r, bytes: end.bytes },
        "recording: finished without the guest's last fragments",
      );
    }
  }

  private stop(sessionId: string, why: string, cursor: PullCursor): "done" {
    this.d.store.finishPull(sessionId);
    this.d.log.warn(
      { session: sessionId, why, seq: cursor.seq, bytes: cursor.bytes },
      "recording: stopped pulling; the recording keeps what it has",
    );
    return "done";
  }

  private async pullOnce(
    sessionId: string,
    address: string,
    token: string,
    timeoutMs: number,
  ): Promise<PullResult> {
    const cursor = this.d.store.getPull(sessionId);
    const rec = this.d.store.getRecording(sessionId);
    if (!cursor || !rec || cursor.done) return "done";
    let got: { meta: RecordingFragments; body: Buffer };
    try {
      got = await this.d.runtime.recordingFragments(
        address,
        token,
        cursor.seq,
        timeoutMs,
      );
    } catch (e) {
      if (e instanceof RuntimeHttpError && e.status === 404)
        return this.stop(sessionId, "the guest has no pull recording", cursor);
      if (e instanceof RuntimeHttpError && e.status === 409)
        return this.stop(sessionId, "the guest refused the cursor", cursor);
      return "error";
    }
    const why = invalid(got, cursor);
    if (why) return this.stop(sessionId, why, cursor);
    const { meta, body } = got;
    if (meta.fragments.length === 0) {
      if (!meta.done) return "idle";
      this.d.store.finishPull(sessionId);
      return "done";
    }
    if (cursor.bytes + body.length > RECORDING_LIMITS.volumeBytes)
      return this.stop(
        sessionId,
        "the recording reached its size limit",
        cursor,
      );

    const dir = await this.d.volumes.path(rec.volume);
    if (!dir)
      return this.stop(sessionId, "the recording volume is gone", cursor);
    // The volume is the agent's: never mounted into a guest, so nothing hostile has been in it.
    // Still opened without following a link, as a regular file.
    const fd = await open(
      join(dir, RECORDING_FILE),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      const st = await fd.stat();
      if (!st.isFile())
        return this.stop(
          sessionId,
          "the recording is not a regular file",
          cursor,
        );
      if (st.size < cursor.bytes)
        return this.stop(
          sessionId,
          "the recording file is shorter than recorded",
          cursor,
        );
      // Bytes past the cursor were written by a pull the agent crashed before recording.
      if (st.size > cursor.bytes) await fd.truncate(cursor.bytes);
      let off = 0;
      while (off < body.length) {
        const { bytesWritten } = await fd.write(
          body,
          off,
          body.length - off,
          cursor.bytes + off,
        );
        off += bytesWritten;
      }
      await fd.datasync();
    } finally {
      await fd.close();
    }
    const to = {
      seq: meta.fragments[meta.fragments.length - 1]!.seq,
      bytes: cursor.bytes + body.length,
    };
    if (!this.d.store.advancePull(sessionId, cursor, to)) return "error";
    if (meta.done) {
      this.d.store.finishPull(sessionId);
      return "done";
    }
    return "more";
  }
}

/** Why an answer cannot be appended, or null. The schema and the body's size are already checked. */
export function invalid(
  got: { meta: RecordingFragments; body: Buffer },
  cursor: { seq: number; bytes: number },
): string | null {
  let off = 0;
  for (const [i, f] of got.meta.fragments.entries()) {
    if (f.seq !== cursor.seq + 1 + i)
      return `fragment ${f.seq} does not follow ${cursor.seq + i}`;
    const frag = got.body.subarray(off, off + f.bytes);
    const c = checkMp4Fragment(
      frag,
      cursor.bytes === 0 && i === 0,
      RECORDING_LIMITS.fragmentBytes,
    );
    if ("error" in c) return `fragment ${f.seq}: ${c.error}`;
    off += f.bytes;
  }
  return off === got.body.length
    ? null
    : "the body is not the fragments described";
}
