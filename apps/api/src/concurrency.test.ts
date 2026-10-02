import { ErrorResponse, Session } from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NON_TERMINAL } from "./lifecycle.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
const reset = async (opts: Parameters<typeof makeEnv>[0] = {}) => {
  await env?.close();
  env = await makeEnv(opts);
};
afterAll(async () => env?.close());
beforeEach(() => reset());

const codes = (rs: { statusCode: number }[]) =>
  rs.reduce<Record<number, number>>(
    (m, r) => ({ ...m, [r.statusCode]: (m[r.statusCode] ?? 0) + 1 }),
    {},
  );

describe("concurrent creates cannot oversubscribe", () => {
  it("admits exactly the free slots (K2, K3)", async () => {
    await reset({ nodes: [{ id: "a", slots: 5 }] });
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => env.create()),
    );
    expect(codes(rs)).toEqual({ 201: 5, 503: 15 });
    expect(
      await env.db.session.count({ where: { status: { in: NON_TERMINAL } } }),
    ).toBe(5);
    expect(env.nodes.a!.held.size).toBe(5);
  });

  it("admits exactly the quota", async () => {
    await reset({ maxConcurrentSessions: 3 });
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => env.create()),
    );
    expect(codes(rs)).toEqual({ 201: 3, 429: 7 });
  });

  it("spreads over two nodes without exceeding either", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 3 },
        { id: "b", slots: 2 },
      ],
    });
    const rs = await Promise.all(
      Array.from({ length: 12 }, () => env.create()),
    );
    expect(codes(rs)).toEqual({ 201: 5, 503: 7 });
    expect(env.nodes.a!.held.size).toBe(3);
    expect(env.nodes.b!.held.size).toBe(2);
  });

  it("lets waiters take slots as they free, each slot used once", async () => {
    await reset({ nodes: [{ id: "a", slots: 2 }] });
    const first = [
      Session.parse((await env.create()).json()),
      Session.parse((await env.create()).json()),
    ];
    const waiters = Array.from({ length: 4 }, () =>
      env.create({ waitForCapacityMs: 4000 }),
    );
    await new Promise((r) => setTimeout(r, 300));
    for (const s of first) await env.call("POST", `/v1/sessions/${s.id}/stop`);
    await env.nodes.a!.flushReports(env.internal);
    // two of the four can now start; free those too so all four finish
    const early = await Promise.race([
      Promise.all(waiters),
      new Promise((r) => setTimeout(() => r("pending"), 800)),
    ]);
    expect(early).toBe("pending");
    expect(
      await env.db.session.count({ where: { status: { in: NON_TERMINAL } } }),
    ).toBeLessThanOrEqual(2);
    // release the two that took the freed slots so the remaining waiters can finish
    const live = (await env.call("GET", "/v1/sessions?status=ready")).json()
      .data as Session[];
    for (const s of live) await env.call("POST", `/v1/sessions/${s.id}/stop`);
    await env.nodes.a!.flushReports(env.internal);
    const results = await Promise.all(waiters);
    expect(codes(results)).toEqual({ 201: 4 });
    expect(new Set(results.map((r) => Session.parse(r.json()).id)).size).toBe(
      4,
    );
  });
});

describe("concurrent duplicates", () => {
  it("create exactly one session for one idempotency key", async () => {
    // Hold the first start open so the others arrive while it is in progress.
    env.nodes.a!.startMode = "hang";
    const rs = Array.from({ length: 10 }, () =>
      env.create({ idempotencyKey: "dup" }),
    );
    await new Promise((r) => setTimeout(r, 300));
    env.nodes.a!.unhang();
    const done = await Promise.all(rs);

    expect(await env.db.session.count()).toBe(1);
    expect(env.nodes.a!.startCalls).toHaveLength(1);
    const c = codes(done);
    expect(c[201]).toBe(1);
    // every other request was told "in progress" (409) or, if it arrived late, got the same session (200)
    expect((c[409] ?? 0) + (c[200] ?? 0)).toBe(9);
    for (const r of done.filter((d) => d.statusCode === 409)) {
      expect(ErrorResponse.parse(r.json()).error).toMatchObject({
        code: "conflict",
        retryable: true,
      });
    }
    for (const r of done.filter((d) => d.statusCode !== 409)) {
      expect(Session.parse(r.json()).id).toBe(
        Session.parse(done.find((d) => d.statusCode === 201)!.json()).id,
      );
    }
    // and afterwards a retry returns the same session
    const again = await env.create({ idempotencyKey: "dup" });
    expect(again.statusCode).toBe(200);
  });

  it("stop once on the node however many stops arrive", async () => {
    const s = Session.parse((await env.create()).json());
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        env.call("POST", `/v1/sessions/${s.id}/stop`),
      ),
    );
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(env.nodes.a!.stopCalls).toHaveLength(1);
    const events = await env.db.sessionEvent.findMany({
      where: { type: "session.stopping" },
    });
    expect(events).toHaveLength(1);
  });
});
