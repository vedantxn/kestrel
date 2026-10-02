/** Time as a dependency, so tests can move it and so every timestamp comes from one place. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests control. */
export class FakeClock implements Clock {
  constructor(private t = Date.parse("2026-10-02T12:00:00.000Z")) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
