import { describe, expect, it } from "vitest";
import { CASES } from "./chaos.js";

describe("chaos cases per runtime (G-25)", () => {
  const byId = new Map(CASES.map((c) => [c.id, c]));

  it("has the microVM cases, each run only against a microVM node", () => {
    for (const id of ["kill-vmm", "kill-uffd-handler", "restart-agent-vms"])
      expect(byId.get(id)?.requires, id).toBe("microvm");
  });

  it("runs the cases that reach into a container only against a Docker node", () => {
    for (const c of CASES) {
      const src = c.run.toString();
      if (/inContainer|docker exec|docker rm -f/.test(src))
        expect(c.requires, c.id).toBe("docker");
    }
  });

  it("names every case once", () => {
    expect(byId.size).toBe(CASES.length);
  });
});
