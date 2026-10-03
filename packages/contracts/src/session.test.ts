import { describe, expect, it } from "vitest";
import {
  CreateSessionRequest,
  END_REASONS,
  SESSION_STATUSES,
  SessionOptions,
  TRANSITIONS,
  canTransition,
  isTerminal,
  terminalStatusFor,
} from "./session.js";
import { LIMITS } from "./timings.js";

describe("session state machine", () => {
  it("lets every non-terminal status before stopping move to stopping, and nothing leave a terminal one", () => {
    for (const s of SESSION_STATUSES) {
      if (isTerminal(s)) expect(TRANSITIONS[s]).toEqual([]);
      else if (s !== "stopping")
        expect(canTransition(s, "stopping")).toBe(true);
    }
  });

  it("only reaches a terminal status through stopping", () => {
    for (const from of SESSION_STATUSES) {
      for (const to of ["stopped", "failed", "timed_out"] as const) {
        expect(canTransition(from, to)).toBe(from === "stopping");
      }
    }
  });

  it("walks the happy path and rejects skipping", () => {
    expect(canTransition("requested", "scheduling")).toBe(true);
    expect(canTransition("scheduling", "starting")).toBe(true);
    expect(canTransition("starting", "ready")).toBe(true);
    expect(canTransition("ready", "active")).toBe(true);
    expect(canTransition("active", "ready")).toBe(true);
    expect(canTransition("requested", "ready")).toBe(false);
    expect(canTransition("ready", "starting")).toBe(false);
  });

  it("maps every end reason to the terminal status in the HLD", () => {
    expect(terminalStatusFor("client_stop")).toBe("stopped");
    expect(terminalStatusFor("client_disconnect")).toBe("stopped");
    expect(terminalStatusFor("idle_timeout")).toBe("timed_out");
    expect(terminalStatusFor("max_lifetime")).toBe("timed_out");
    for (const r of [
      "browser_crash",
      "oom",
      "runtime_crash",
      "node_lost",
      "start_timeout",
      "disk_limit",
      "node_refused",
    ] as const) {
      expect(terminalStatusFor(r)).toBe("failed");
    }
    expect(
      END_REASONS.every((r) =>
        ["stopped", "failed", "timed_out"].includes(terminalStatusFor(r)),
      ),
    ).toBe(true);
  });
});

describe("session options", () => {
  it("applies the documented defaults", () => {
    const o = SessionOptions.parse({});
    expect(o).toEqual({
      timeout: 15 * 60_000,
      idleTimeout: 5 * 60_000,
      stopOnDisconnect: false,
      viewport: { width: 1280, height: 720 },
      network: {},
      metadata: {},
      recording: false,
    });
  });

  it("rejects an unknown option, in a request and nested", () => {
    expect(CreateSessionRequest.safeParse({ proxy: "x" }).success).toBe(false);
    expect(
      CreateSessionRequest.safeParse({
        viewport: { width: 800, height: 600, scale: 2 },
      }).success,
    ).toBe(false);
    expect(
      CreateSessionRequest.safeParse({ network: { block: [] } }).success,
    ).toBe(false);
  });

  it("applies limits", () => {
    expect(
      CreateSessionRequest.safeParse({
        timeout: LIMITS.maxSessionTimeoutMs + 1,
      }).success,
    ).toBe(false);
    expect(CreateSessionRequest.safeParse({ timeout: 999 }).success).toBe(
      false,
    );
    expect(
      CreateSessionRequest.safeParse({ waitForCapacityMs: 60_001 }).success,
    ).toBe(false);
    expect(
      CreateSessionRequest.safeParse({ viewport: { width: 5000, height: 720 } })
        .success,
    ).toBe(false);
    expect(CreateSessionRequest.safeParse({ idempotencyKey: "" }).success).toBe(
      false,
    );
  });

  it("applies defaults to a request, so the API sees every option resolved", () => {
    expect(CreateSessionRequest.parse({})).toEqual(SessionOptions.parse({}));
    expect(CreateSessionRequest.parse({ timeout: 20_000 }).timeout).toBe(
      20_000,
    );
    expect(
      CreateSessionRequest.parse({ idempotencyKey: "k" }).idempotencyKey,
    ).toBe("k");
  });

  it("normalises and checks host patterns", () => {
    const ok = CreateSessionRequest.parse({
      network: { allow: ["Example.COM", "*.s3.amazonaws.com"] },
    });
    expect(ok.network?.allow).toEqual(["example.com", "*.s3.amazonaws.com"]);
    for (const bad of [
      "http://example.com",
      "exa mple.com",
      "*",
      "*example.com",
      "a.*.com",
      "1.2.3.4",
      "*.1.2",
    ]) {
      expect(
        CreateSessionRequest.safeParse({ network: { deny: [bad] } }).success,
        bad,
      ).toBe(false);
    }
  });

  it("limits metadata", () => {
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(CreateSessionRequest.safeParse({ metadata: many }).success).toBe(
      false,
    );
    expect(
      CreateSessionRequest.safeParse({ metadata: { k: "v".repeat(513) } })
        .success,
    ).toBe(false);
    expect(
      CreateSessionRequest.safeParse({ metadata: { run: "42" } }).success,
    ).toBe(true);
  });
});
