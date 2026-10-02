import { ErrorResponse, ListEventsResponse, Session } from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ingestReports } from "./nodes.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
const reset = async (opts: Parameters<typeof makeEnv>[0] = {}) => {
  await env?.close();
  env = await makeEnv(opts);
};
afterAll(async () => env?.close());
beforeEach(() => reset());

const row = (id: string) =>
  env.call("GET", `/v1/sessions/${id}`).then((r) => Session.parse(r.json()));
const node = (id: string) => env.db.node.findUniqueOrThrow({ where: { id } });
const created = async () => Session.parse((await env.create()).json());

async function eventually<T>(
  fn: () => Promise<T | false>,
  ms = 3000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("a paused API must not fail healthy sessions", () => {
  it("restarts the grace after a long pause between ticks", async () => {
    const s = await created();
    for (let i = 0; i < 4; i++) {
      env.clock.advance(5_000);
      await env.nodes.a!.heartbeat(env.internal);
      await env.sweeper.tick();
    }
    expect(env.sweeper.connectedForMs).toBeGreaterThanOrEqual(15_000);
    // The host freezes for 60 s. The node's heartbeat is queued behind the sweeper's timer.
    env.clock.advance(60_000);
    await env.sweeper.tick();
    expect((await node("a")).state).toBe("active");
    expect(env.sweeper.connectedForMs).toBe(0);
    await env.nodes.a!.heartbeat(env.internal);
    expect((await row(s.id)).status).toBe("ready");
  });

  it("restarts the grace when the wall clock steps but the monotonic clock does not", async () => {
    await created();
    let mono = 0;
    env.ctx.monotonic = () => mono;
    for (let i = 0; i < 4; i++) {
      env.clock.advance(5_000);
      mono += 5_000;
      await env.nodes.a!.heartbeat(env.internal);
      await env.sweeper.tick();
    }
    env.clock.advance(60_000); // NTP steps the clock forward
    mono += 5_000;
    await env.sweeper.tick();
    expect((await node("a")).state).toBe("active");
  });
});

describe("hostile or broken reports", () => {
  it("sanitizes control characters in container-supplied text", async () => {
    const s = await created();
    env.nodes.a!.report(s.id, {
      type: "egress.denied",
      data: {
        host: "evil\u0000.test\u0007",
        port: 443,
        reason: "blocked_address",
        count: 1,
      },
    });
    await env.nodes.a!.flushReports(env.internal);
    const events = ListEventsResponse.parse(
      (await env.call("GET", `/v1/sessions/${s.id}/events`)).json(),
    ).data;
    const denied = events.find((e) => e.type === "egress.denied");
    expect(denied && "host" in denied.data && denied.data.host).toBe(
      "evil�.test�",
    );
    expect(env.nodes.a!.reports).toHaveLength(0);
  });

  it("does not let one report that cannot be applied block the ones behind it", async () => {
    const bad = await created();
    const good = await created();
    const a = env.nodes.a!;
    a.report(bad.id, { type: "session.attached", data: { connections: 1 } });
    a.expire(good.id, "idle_timeout");
    const original = env.ctx.db.sessionEvent.createMany.bind(
      env.ctx.db.sessionEvent,
    );
    let calls = 0;
    // The first event insert fails with something that is not a connectivity problem.
    (env.ctx.db.sessionEvent as { createMany: unknown }).createMany = (
      ...args: unknown[]
    ) => {
      if (++calls === 1) throw new Error("invalid input syntax for type json");
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    const res = await ingestReports(env.ctx, {
      nodeId: a.nodeId(),
      epoch: 1,
      reports: a.reports,
    });
    expect(res.acked).toHaveLength(2);
    expect(await row(good.id)).toMatchObject({
      status: "timed_out",
      endReason: "idle_timeout",
    });
  });

  it("fails the whole batch, so the node resends, when the database is unreachable", async () => {
    const s = await created();
    env.nodes.a!.expire(s.id, "idle_timeout");
    (env.ctx.db as { $transaction: unknown }).$transaction = () => {
      throw new Error("Can't reach database server");
    };
    await expect(
      ingestReports(env.ctx, {
        nodeId: env.nodes.a!.nodeId(),
        epoch: 1,
        reports: env.nodes.a!.reports,
      }),
    ).rejects.toThrow();
  });
});

describe("sessions the node no longer holds", () => {
  it("ends a ready session the node silently lost, and frees its slot", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    const s = await created();
    env.nodes.a!.held.clear(); // gone, with no removal report
    env.clock.advance(1_000);
    await env.nodes.a!.heartbeat(env.internal);
    expect((await row(s.id)).status).toBe("ready"); // too soon: that heartbeat may predate the session
    env.clock.advance(6_000);
    await env.nodes.a!.heartbeat(env.internal);
    expect(await row(s.id)).toMatchObject({
      status: "failed",
      endReason: "runtime_crash",
      connectUrl: null,
    });
    expect((await env.create()).statusCode).toBe(201);
  });

  it("does not touch a session the node does hold", async () => {
    const s = await created();
    for (let i = 0; i < 5; i++) {
      env.clock.advance(3_000);
      await env.nodes.a!.heartbeat(env.internal);
    }
    expect((await row(s.id)).status).toBe("ready");
  });

  it("enforces the lifetime limit itself when the node says nothing", async () => {
    const res = await env.create({ timeout: 20_000 });
    const s = Session.parse(res.json());
    for (let t = 0; t < 90; t += 2) {
      env.clock.advance(2_000);
      await env.nodes.a!.heartbeat(env.internal);
      if (t % 4 === 0) await env.sweeper.tick();
    }
    await eventually(async () => env.nodes.a!.stopCalls.length === 1);
    await env.nodes.a!.sync(env.internal);
    expect(await row(s.id)).toMatchObject({
      status: "timed_out",
      endReason: "max_lifetime",
    });
  });
});

describe("a retryable create error can be retried", () => {
  it("makes a new session for the same idempotency key after a failed start", async () => {
    env.nodes.a!.startMode = "fail";
    const first = await env.create({ idempotencyKey: "retry-me" });
    expect(first.statusCode).toBe(500);
    expect(ErrorResponse.parse(first.json()).error.retryable).toBe(true);
    env.nodes.a!.startMode = "hot";
    const second = await env.create({ idempotencyKey: "retry-me" });
    expect(second.statusCode).toBe(201);
    expect(Session.parse(second.json()).status).toBe("ready");
    expect(await env.db.session.count()).toBe(2);
  });
});

describe("waiting places", () => {
  it("one project cannot use them all", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    await created();
    const hogs = Array.from({ length: 50 }, () =>
      env.create({ waitForCapacityMs: 1500 }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    const over = await env.create({ waitForCapacityMs: 1500 });
    expect(over.statusCode).toBe(503);
    expect(Date.now() - t).toBeLessThan(150); // refused at once: this project's places are used
    // another project can still wait
    const other = env.create({ waitForCapacityMs: 600 }, env.project2.key);
    const t2 = Date.now();
    expect((await other).statusCode).toBe(503); // no slot ever frees, but it did wait
    expect(Date.now() - t2).toBeGreaterThanOrEqual(500);
    await Promise.all(hogs);
  });
});

describe("input that used to cause a 500", () => {
  it("answers 400 to cursors that cannot be real", async () => {
    const huge = Buffer.from(
      `1e20|01890a5d-ac96-774b-bcce-b302099a8057`,
    ).toString("base64url");
    const dashes = Buffer.from(`1000|${"-".repeat(36)}`).toString("base64url");
    expect(
      (await env.call("GET", `/v1/sessions?cursor=${huge}`)).statusCode,
    ).toBe(400);
    expect(
      (await env.call("GET", `/v1/sessions?cursor=${dashes}`)).statusCode,
    ).toBe(400);
    const s = await created();
    const big = Buffer.from("9".repeat(23)).toString("base64url");
    expect(
      (await env.call("GET", `/v1/sessions/${s.id}/events?cursor=${big}`))
        .statusCode,
    ).toBe(400);
  });

  it("answers 400 to control characters in caller-supplied strings", async () => {
    expect((await env.create({ idempotencyKey: "a\u0000b" })).statusCode).toBe(
      400,
    );
    expect(
      (await env.create({ metadata: { "k\u0000": "v" } })).statusCode,
    ).toBe(400);
    expect((await env.create({ metadata: { k: "v\u0000" } })).statusCode).toBe(
      400,
    );
    expect((await env.create({ metadata: { k: "plain" } })).statusCode).toBe(
      201,
    );
  });
});

describe("the sweeper and removal reports do not deadlock", () => {
  it("survive each other across many trials", async () => {
    for (let trial = 0; trial < 12; trial++) {
      await reset({ nodes: [{ id: "a", slots: 3 }] });
      const sessions = [await created(), await created(), await created()];
      for (let t = 0; t < 4; t++) {
        env.clock.advance(5_000);
        await env.nodes.a!.heartbeat(env.internal);
        await env.sweeper.tick();
      }
      // The node goes quiet and the sweeper is about to declare it lost, while reports for its sessions arrive.
      for (const s of sessions) env.nodes.a!.expire(s.id, "idle_timeout");
      for (let t = 0; t < 3; t++) env.clock.advance(5_000);
      const results = await Promise.all([
        env.sweeper.tick(),
        env.nodes.a!.flushReports(env.internal).then(
          () => "ok",
          (e) => String(e),
        ),
      ]);
      expect(results[1]).toBe("ok");
      expect(env.sweeper.connectedForMs).not.toBeNull(); // the tick did not fail
    }
  });
});
