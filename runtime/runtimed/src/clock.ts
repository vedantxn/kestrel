import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * A microVM clone's wall clock (threat model 9.1, G-24). A clone resumes with the template's clock,
 * so every clone would be behind the host by the template's age, all by the same amount. runtimed
 * runs unprivileged and cannot set the clock; the guest's init reads the time from a pipe only
 * runtimed's user can write and sets it as root (runtime/microvm/init). A runtimed that lied would
 * only misdate its own VM.
 */
export interface GuestClock {
  /** Set the clock to `epochMs` (as read on the host); true once the guest's clock agrees. */
  set(epochMs: number): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pipeClock(
  path: string,
  opts: {
    now?: () => number;
    monotonic?: () => number;
    toleranceMs?: number;
    waitMs?: number;
  } = {},
): GuestClock {
  const now = opts.now ?? Date.now;
  const monotonic = opts.monotonic ?? (() => performance.now());
  const tolerance = opts.toleranceMs ?? 1_000;
  const waitMs = opts.waitMs ?? 1_000;
  return {
    async set(epochMs) {
      const received = monotonic();
      // Non-blocking: with no reader the open fails at once (ENXIO) rather than hang the rekey.
      const fh = await open(
        path,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch(() => null);
      if (!fh) return false;
      try {
        await fh.write(`${(epochMs / 1000).toFixed(3)}\n`);
      } catch {
        return false;
      } finally {
        await fh.close();
      }
      // The target moves on while init sets it: the host's time plus what has passed since, measured
      // on the monotonic clock (the wall clock is the one that jumps).
      for (;;) {
        const elapsed = monotonic() - received;
        if (Math.abs(now() - (epochMs + elapsed)) <= tolerance) return true;
        if (elapsed >= waitMs) return false;
        await sleep(10);
      }
    },
  };
}
