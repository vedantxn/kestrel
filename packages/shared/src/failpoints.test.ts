import { describe, expect, it, vi } from "vitest";
import { FailpointError, Failpoints } from "./failpoints.js";

describe("failpoints", () => {
  it("does nothing when nothing is armed", async () => {
    const f = new Failpoints();
    expect(f.anyActive).toBe(false);
    expect(await f.hit("api.node_stop")).toBeUndefined();
  });

  it("parses the environment form and describes what is armed", () => {
    const f = new Failpoints(
      "api.create.after_reserve=exit, api.node_stop=drop:once",
    );
    expect(f.describe()).toEqual({
      "api.create.after_reserve": "exit",
      "api.node_stop": "drop:once",
    });
  });

  it("rejects typos and unknown actions at startup", () => {
    expect(() => new Failpoints("api.node_stopp=drop")).toThrow(
      /unknown failpoint/,
    );
    expect(() => new Failpoints("api.node_stop=explode")).toThrow(
      /unknown failpoint action/,
    );
    expect(() => new Failpoints("api.node_stop=stall:abc")).toThrow(
      /bad stall/,
    );
    expect(() => new Failpoints("nonsense")).toThrow(/bad failpoint entry/);
  });

  it("drops once, then lets the step happen", async () => {
    const f = new Failpoints("api.node_stop=drop:once");
    expect(await f.hit("api.node_stop")).toBe("drop");
    expect(await f.hit("api.node_stop")).toBeUndefined();
    expect(f.anyActive).toBe(false);
  });

  it("keeps firing without :once", async () => {
    const f = new Failpoints("api.node_stop=drop");
    expect(await f.hit("api.node_stop")).toBe("drop");
    expect(await f.hit("api.node_stop")).toBe("drop");
  });

  it("throws, stalls and exits", async () => {
    const exit = vi.fn(() => {
      throw new Error("exited");
    }) as unknown as (c: number) => never;
    const f = new Failpoints(undefined, undefined, exit);
    f.set("api.create.before_ready", "throw");
    await expect(f.hit("api.create.before_ready")).rejects.toBeInstanceOf(
      FailpointError,
    );
    f.set("api.sweeper.tick", "stall:20");
    const t = Date.now();
    await f.hit("api.sweeper.tick");
    expect(Date.now() - t).toBeGreaterThanOrEqual(15);
    f.set("api.create.after_reserve", "exit");
    await expect(f.hit("api.create.after_reserve")).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(137);
  });
});
