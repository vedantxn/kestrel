import type { AddressInfo } from "node:net";
import { Session } from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicApp } from "../apps/api/src/http.js";
import { makeEnv, type Env } from "../apps/api/src/test/harness.js";
import { ApiError, KestrelClient } from "../bench/framework/src/client.js";
import type { Driver } from "../bench/framework/src/driver.js";
import { runBatch, runLifecycle } from "../bench/framework/src/lifecycle.js";

describe("the lifecycle runner, against the real API over HTTP", () => {
  let env: Env;
  let pump: NodeJS.Timeout | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    clearInterval(pump);
    await close?.();
    await env?.close();
  });

  async function setup(
    slots = 5,
    driver?: Partial<Driver> & { drive?: Driver["drive"] },
  ) {
    env = await makeEnv({ nodes: [{ id: "a", slots }] });
    const app = buildPublicApp(env.ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // The fake node confirms removals as a real agent would, in the background.
    pump = setInterval(
      () => void env.nodes.a!.sync(env.internal).catch(() => undefined),
      20,
    );
    const client = new KestrelClient(url, env.key, 10_000);
    const d: Driver = {
      name: "fake",
      drive:
        driver?.drive ??
        (async (s) => ({
          connectMs: 5,
          navMs: 7,
          title: "Kestrel test page",
          innerWidth: s.viewport.width,
          innerHeight: s.viewport.height,
        })),
    };
    return { client, d };
  }
  const opts = {
    testPageUrl: "https://example.test/",
    expectTitle: "Kestrel test page",
  };

  it("runs a lifecycle: create, drive, stop, and wait for a terminal status", async () => {
    const { client, d } = await setup();
    const r = await runLifecycle(client, d, {
      ...opts,
      create: { viewport: { width: 900, height: 500 } },
      expectViewport: { width: 900, height: 500 },
    });
    expect(r).toMatchObject({ ok: true, startPath: "hot" });
    expect(r.createMs).toBeGreaterThan(0);
    const [s] = await client.list();
    expect(s?.status).toBe("stopped");
  });

  it("names the phase that failed, and still stops the session (no leak)", async () => {
    const { client } = await setup();
    const cases: [string, Driver, string][] = [
      [
        "connect",
        {
          name: "x",
          drive: async () => {
            throw new Error("socket hang up");
          },
        },
        "socket hang up",
      ],
      [
        "load",
        {
          name: "x",
          drive: async () => ({
            connectMs: 1,
            navMs: 1,
            title: "Error",
            innerWidth: 1280,
            innerHeight: 720,
          }),
        },
        "page title",
      ],
      [
        "assert",
        {
          name: "x",
          drive: async () => ({
            connectMs: 1,
            navMs: 1,
            title: "Kestrel test page",
            innerWidth: 1,
            innerHeight: 1,
          }),
        },
        "measured 1x1",
      ],
    ];
    for (const [phase, d, msg] of cases) {
      const r = await runLifecycle(client, d, {
        ...opts,
        expectViewport: { width: 1280, height: 720 },
      });
      expect(r, phase).toMatchObject({ ok: false, phase });
      expect(r.error).toContain(msg);
    }
    const all = await client.list();
    expect(
      all.every((s) => ["stopped", "failed", "timed_out"].includes(s.status)),
    ).toBe(true);
  });

  it("reports a refused create as the create phase, with the API's own error", async () => {
    const { client, d } = await setup(1);
    const held = await client.create();
    const r = await runLifecycle(client, d, opts);
    expect(r).toMatchObject({ ok: false, phase: "create" });
    expect(r.error).toContain("capacity_exhausted");
    await client.stop(held.session.id);
  });

  it("runs a concurrent batch and summarises it, with the hot share", async () => {
    const { client, d } = await setup(5);
    let last = [0, 0];
    const b = await runBatch(client, d, {
      ...opts,
      count: 30,
      concurrency: 4,
      waitForCapacityMs: 5000,
      onProgress: (done, failed) => (last = [done, failed]),
    });
    expect(b.total).toBe(30);
    expect(b.failures).toEqual([]);
    expect(last).toEqual([30, 0]);
    expect(b.hotShare).toBe(1);
    expect(b.create.n).toBe(30);
    expect(b.lifecycle.p50).toBeGreaterThan(0);
    expect(b.wallMs).toBeGreaterThan(0);
    const all = await client.list("?limit=100");
    expect(all).toHaveLength(30);
  });

  it("counts every failure in a batch and keeps going", async () => {
    let n = 0;
    const { client } = await setup(5);
    const flaky: Driver = {
      name: "flaky",
      drive: async (s) => {
        if (++n % 5 === 0) throw new Error("boom");
        return {
          connectMs: 1,
          navMs: 1,
          title: "Kestrel test page",
          innerWidth: s.viewport.width,
          innerHeight: s.viewport.height,
        };
      },
    };
    const b = await runBatch(client, flaky, {
      ...opts,
      count: 20,
      concurrency: 1,
    });
    expect(b.failures).toHaveLength(4);
    expect(b.failures.every((f) => f.phase === "connect")).toBe(true);
    expect(b.total).toBe(20);
  });
});

describe("the client", () => {
  let env: Env;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    await env?.close();
  });

  it("turns the API's error shape into an ApiError and validates responses against the contract", async () => {
    env = await makeEnv();
    const app = buildPublicApp(env.ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const bad = new KestrelClient(url, "ksl_" + "x".repeat(43));
    await expect(bad.list()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      retryable: false,
    });
    const client = new KestrelClient(url, env.key);
    await expect(client.create({ proxy: "x" })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(client.get("ses_" + "0".repeat(26))).rejects.toMatchObject({
      code: "not_found",
    });
    const { session } = await client.create();
    expect(Session.safeParse(session).success).toBe(true);
    await expect(
      client.waitFor(session.id, ["stopped"], 150, 20),
    ).rejects.toThrow(/wanted stopped/);
  });
});
