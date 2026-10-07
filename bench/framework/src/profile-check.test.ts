import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileId, Session } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import { ApiError, type KestrelClient } from "./client.js";
import {
  CHAOS,
  judgeWarmLatency,
  profileCheckConfigFromEnv,
  singleWriter,
} from "./profile-check.js";

const PRF = "prf_01k6zzzzzzzzzzzzzzzzzzzzzz" as ProfileId;

/** A client whose creates answer from a script, for judging what the API said. */
function scripted(
  answers: ("ok" | "409" | "409-final" | "503")[],
  opts: { lockStuck?: boolean } = {},
) {
  let i = 0;
  const stopped: string[] = [];
  const session = (n: number) =>
    ({ id: `ses_${n}`, status: "ready", nodeId: "a" }) as unknown as Session;
  const client = {
    async create() {
      const a = answers[i++] ?? "ok";
      if (a === "ok") return { session: session(i), created: true };
      if (a === "503")
        throw new ApiError(503, "capacity_exhausted", "full", true);
      throw new ApiError(
        409,
        "conflict",
        "in use",
        a === "409",
        undefined,
        "profile.id",
      );
    },
    async stop(id: string) {
      stopped.push(id);
      return session(0);
    },
    async waitFor() {
      return session(0);
    },
    // The writer (the first create) holds the lock until it is stopped, or forever.
    async getProfile() {
      return {
        inUseBy: opts.lockStuck || !stopped.includes("ses_1") ? "ses_1" : null,
      };
    },
  } as unknown as KestrelClient;
  return { client, stopped };
}

describe("judging one writer (P18 check 4)", () => {
  it("fails when the lock is not free soon after the writer ends", async () => {
    const { client } = scripted(["ok", "409", "409", "ok", "ok", "ok"], {
      lockStuck: true,
    });
    await expect(
      singleWriter(client, PRF, {
        writers: 3,
        readers: 2,
        withinMs: 50,
        lockWaitMs: 200,
      }),
    ).rejects.toThrow(/to be free/);
  });

  const o = { writers: 3, readers: 2, withinMs: 1000 };

  it("passes one writer, the rest refused retryably on profile.id, and every reader", async () => {
    const { client, stopped } = scripted([
      "ok",
      "409",
      "409",
      "ok",
      "ok",
      "ok",
    ]);
    const r = await singleWriter(client, PRF, o);
    expect(r.pass).toBe(true);
    expect(r.releaseMs).not.toBeNull();
    // The readers, the writer and the next writer are all stopped.
    expect(stopped).toHaveLength(4);
  });

  it("names two writers started, a refusal that is not retryable, another error, and a reader refused", async () => {
    expect(
      (
        await singleWriter(
          scripted(["ok", "ok", "409", "ok", "ok", "ok"]).client,
          PRF,
          o,
        )
      ).detail,
    ).toContain("2 writers started");
    expect(
      (
        await singleWriter(
          scripted(["ok", "409", "409-final", "ok", "ok", "ok"]).client,
          PRF,
          o,
        )
      ).detail,
    ).toContain("a 409 was not retryable");
    const other = await singleWriter(
      scripted(["ok", "409", "503", "ok", "ok", "ok"]).client,
      PRF,
      o,
    );
    expect(other.pass).toBe(false);
    expect(other.detail).toContain("1 refused 409 on profile.id");
    expect(other.detail).toContain("capacity_exhausted");
    const reader = await singleWriter(
      scripted(["ok", "409", "409", "ok", "503", "ok"]).client,
      PRF,
      o,
    );
    expect(reader.detail).toContain("1 of 2 readers started");
  });
});

describe("judging warm latency (P18 check 9)", () => {
  it("holds each runtime to its own budget", () => {
    const ms = (p50: number, slow: number) => [
      ...Array.from({ length: 18 }, () => p50),
      slow,
      slow,
    ];
    expect(judgeWarmLatency("docker", ms(900, 1900))).toMatchObject({
      pass: true,
      p50: 900,
      p95: 1900,
    });
    expect(judgeWarmLatency("docker", ms(1300, 1400)).pass).toBe(true);
    expect(judgeWarmLatency("docker", ms(1600, 1600)).pass).toBe(false);
    expect(judgeWarmLatency("docker", ms(900, 2100)).pass).toBe(false);
    expect(judgeWarmLatency("microvm", ms(1800, 2900)).pass).toBe(true);
    expect(judgeWarmLatency("microvm", ms(2100, 2100)).pass).toBe(false);
    expect(judgeWarmLatency("microvm", ms(1400, 3100)).pass).toBe(false);
    expect(judgeWarmLatency("microvm", []).pass).toBe(false);
  });
});

describe("bench profiles' configuration and cases", () => {
  it("reads its settings from the environment, with the LLD's numbers by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cfg-"));
    writeFileSync(join(dir, "key"), "ksl_x\n");
    const env = {
      PUBLIC_HOSTNAME: "h.example",
      PUBLIC_IP: "203.0.113.1",
      API_KEY_FILE: join(dir, "key"),
      TEST_PAGE_URL: "https://bucket.s3.us-east-1.amazonaws.com/test/",
      TWO_NODES: "1",
      RUNTIME_A: "microvm",
    };
    const c = profileCheckConfigFromEnv(env, () => undefined);
    expect(c).toMatchObject({
      apiKey: "ksl_x",
      latencySamples: 50,
      latencyProfileMib: 5,
      tooLargeMib: 80,
      compose: { runtimeA: "microvm", twoNodes: true },
      paths: {
        masterKeyFile: "/secrets/profile-master.key",
        storeDir: "/var/lib/kestrel/profiles",
      },
    });
    expect(c.host.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    const q = profileCheckConfigFromEnv(
      {
        ...env,
        QUICK: "1",
        ONLY: "1,11",
        PROFILE_CHAOS_CASES: "postgres-down-across-save",
      },
      () => undefined,
    );
    expect(q).toMatchObject({
      latencySamples: 10,
      only: [1, 11],
      chaosOnly: ["postgres-down-across-save"],
    });
  });

  it("has the chaos cases of check 11 but the host reboot, each named once", () => {
    expect(CHAOS.map((x) => x.id)).toEqual([
      "agent-restart-during-save",
      "agent-crash-after-write",
      "api-restart-during-commit",
      "postgres-down-across-save",
    ]);
  });
});
