import {
  ErrorResponse,
  ListEventsResponse,
  ListSessionsResponse,
  Session,
} from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "./auth.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
const reset = async (opts: Parameters<typeof makeEnv>[0] = {}) => {
  await env?.close();
  env = await makeEnv(opts);
};
beforeEach(() => reset());
afterAll(async () => env?.close());

const error = (res: { json(): unknown }) =>
  ErrorResponse.parse(res.json()).error;

describe("authentication", () => {
  it("needs a valid key, by either header", async () => {
    expect(
      (await env.api.inject({ method: "GET", url: "/v1/sessions" })).statusCode,
    ).toBe(401);
    expect(
      (await env.call("GET", "/v1/sessions", "ksl_" + "x".repeat(43)))
        .statusCode,
    ).toBe(401);
    expect(
      (await env.call("GET", "/v1/sessions", "not a key")).statusCode,
    ).toBe(401);
    expect((await env.call("GET", "/v1/sessions")).statusCode).toBe(200);
    const viaHeader = await env.api.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { "x-api-key": env.key },
    });
    expect(viaHeader.statusCode).toBe(200);
    const e = error(
      await env.api.inject({ method: "GET", url: "/v1/sessions" }),
    );
    expect(e).toMatchObject({ code: "unauthorized", retryable: false });
    expect(e.requestId).toMatch(/^req_/);
  });

  it("stores only a hash of the key", async () => {
    const rows = await env.db.apiKey.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(r)).not.toContain(env.key);
    }
  });

  it("stops accepting a revoked key at once (G-02)", async () => {
    const { key, id } = await createApiKey(
      env.db,
      env.projectId,
      "temp",
      new Date(),
    );
    expect((await env.call("GET", "/v1/sessions", key)).statusCode).toBe(200);
    await env.db.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    expect((await env.call("GET", "/v1/sessions", key)).statusCode).toBe(401);
  });

  it("serves health and the OpenAPI document without a key", async () => {
    expect(
      (await env.api.inject({ method: "GET", url: "/healthz" })).json(),
    ).toEqual({ status: "ok" });
    const doc = (
      await env.api.inject({ method: "GET", url: "/openapi.json" })
    ).json();
    expect(doc.openapi).toBe("3.1.0");
  });
});

describe("validation (A4)", () => {
  it("names an unknown option", async () => {
    const res = await env.create({ proxy: "http://x" });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({
      code: "invalid_request",
      param: "proxy",
      retryable: false,
    });
    expect(error(res).message).toContain('"proxy"');
  });

  it("names a nested unknown option and a bad value", async () => {
    expect(
      error(
        await env.create({ viewport: { width: 800, height: 600, scale: 2 } }),
      ).param,
    ).toBe("viewport.scale");
    const bad = await env.create({ timeout: 5 });
    expect(bad.statusCode).toBe(400);
    expect(error(bad).param).toBe("timeout");
    expect(
      error(await env.create({ network: { allow: ["not a host"] } })).param,
    ).toBe("network.allow.0");
  });

  it("accepts an empty body and rejects malformed JSON", async () => {
    const empty = await env.api.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        authorization: `Bearer ${env.key}`,
        "content-type": "application/json",
      },
    });
    expect(empty.statusCode).toBe(201);
    const bad = await env.api.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: "{nope",
      headers: {
        authorization: `Bearer ${env.key}`,
        "content-type": "application/json",
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(error(bad).code).toBe("invalid_request");
  });

  it("limits the body size (G-13)", async () => {
    const big = await env.create({ metadata: { k: "v".repeat(70_000) } });
    expect(big.statusCode).toBe(400);
  });

  it("returns the one error shape for an unknown endpoint", async () => {
    const res = await env.call("GET", "/v1/nothing");
    expect(res.statusCode).toBe(404);
    expect(error(res).code).toBe("not_found");
  });
});

describe("tenancy (G-12)", () => {
  it("never shows another project's session", async () => {
    const mine = Session.parse((await env.create()).json());
    const theirs = env.project2.key;
    expect(
      (await env.call("GET", `/v1/sessions/${mine.id}`, theirs)).statusCode,
    ).toBe(404);
    expect(
      (await env.call("GET", `/v1/sessions/${mine.id}/events`, theirs))
        .statusCode,
    ).toBe(404);
    const stop = await env.call("POST", `/v1/sessions/${mine.id}/stop`, theirs);
    expect(stop.statusCode).toBe(404);
    expect(
      ListSessionsResponse.parse(
        (await env.call("GET", "/v1/sessions", theirs)).json(),
      ).data,
    ).toEqual([]);
    // and the failed attempt did not stop it
    expect(
      Session.parse((await env.call("GET", `/v1/sessions/${mine.id}`)).json())
        .status,
    ).toBe("ready");
  });

  it("counts quota per project", async () => {
    await reset({ maxConcurrentSessions: 1 });
    expect((await env.create()).statusCode).toBe(201);
    expect((await env.create({}, env.project2.key)).statusCode).toBe(201);
  });

  it("answers not_found for a malformed id", async () => {
    expect((await env.call("GET", "/v1/sessions/nonsense")).statusCode).toBe(
      404,
    );
    expect(
      (await env.call("POST", "/v1/sessions/nonsense/stop")).statusCode,
    ).toBe(404);
  });
});

describe("quota and capacity", () => {
  it("answers 429 with Retry-After when the project is at its limit, then recovers", async () => {
    await reset({ maxConcurrentSessions: 2 });
    const a = Session.parse((await env.create()).json());
    await env.create();
    const over = await env.create();
    expect(over.statusCode).toBe(429);
    expect(error(over)).toMatchObject({
      code: "quota_exceeded",
      retryable: true,
    });
    expect(over.headers["retry-after"]).toBeDefined();

    await env.call("POST", `/v1/sessions/${a.id}/stop`);
    // still counted until the node confirms removal (K2)
    expect((await env.create()).statusCode).toBe(429);
    await env.nodes.a!.flushReports(env.internal);
    expect((await env.create()).statusCode).toBe(201);
  });

  it("answers 503 capacity_exhausted when the platform is full, and creates no row", async () => {
    await reset({ nodes: [{ id: "a", slots: 2 }] });
    await env.create();
    await env.create();
    const before = await env.db.session.count();
    const full = await env.create();
    expect(full.statusCode).toBe(503);
    expect(error(full)).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
    });
    expect(await env.db.session.count()).toBe(before);
  });

  it("with waitForCapacityMs, waits for a slot and then succeeds", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    const first = Session.parse((await env.create()).json());
    const waiting = env.create({ waitForCapacityMs: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await env.call("POST", `/v1/sessions/${first.id}/stop`);
    await env.nodes.a!.flushReports(env.internal);
    const res = await waiting;
    expect(res.statusCode).toBe(201);
    expect(Session.parse(res.json()).id).not.toBe(first.id);
  });

  it("gives up after waitForCapacityMs", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    await env.create();
    const t = Date.now();
    const res = await env.create({ waitForCapacityMs: 700 });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
  });

  it("prefers a node that reported a hot browser, then the most free capacity (K4)", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    env.nodes.a!.hotCount = 0;
    env.nodes.b!.hotCount = 2;
    await env.syncAll();
    expect(Session.parse((await env.create()).json()).nodeId).toBe("b");
    env.nodes.b!.hotCount = 0;
    env.nodes.a!.hotCount = 0;
    await env.syncAll();
    // b holds one session, a none: the most free capacity wins
    expect(Session.parse((await env.create()).json()).nodeId).toBe("a");
  });

  it("counts a hot browser as taken at once, so a burst spreads to the next hot node", async () => {
    // a has more room, so on free capacity alone it would take both sessions.
    await reset({
      nodes: [
        { id: "a", slots: 9 },
        { id: "b", slots: 5 },
      ],
    });
    env.nodes.a!.hotCount = 1;
    env.nodes.b!.hotCount = 1;
    await env.syncAll();
    // No heartbeat in between: without counting the first take, both would go to the same node.
    const first = Session.parse((await env.create()).json()).nodeId;
    const second = Session.parse((await env.create()).json()).nodeId;
    expect(new Set([first, second])).toEqual(new Set(["a", "b"]));
  });

  it("spreads a run of starts over nodes with warm browsers instead of draining one", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 9 },
        { id: "b", slots: 9 },
      ],
    });
    env.nodes.a!.hotCount = 3;
    env.nodes.b!.hotCount = 3;
    await env.syncAll();
    const placed: string[] = [];
    for (let i = 0; i < 4; i++)
      placed.push(Session.parse((await env.create()).json()).nodeId!);
    // Equal warm pools: the starts alternate, two each, rather than four on "a" by name.
    expect(placed.filter((n) => n === "a")).toHaveLength(2);
    expect(placed.filter((n) => n === "b")).toHaveLength(2);
  });

  it("skips nodes whose heartbeat has gone stale, and fenced nodes", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    env.clock.advance(7_000);
    await env.nodes.b!.heartbeat(env.internal);
    expect(Session.parse((await env.create()).json()).nodeId).toBe("b");
    await env.db.node.update({ where: { id: "b" }, data: { fenced: true } });
    expect((await env.create()).statusCode).toBe(503);
  });

  it("rate-limits creations per project (A14)", async () => {
    await reset({ createsPerMinute: 3 });
    for (let i = 0; i < 3; i++)
      expect((await env.create()).statusCode).toBe(201);
    const limited = await env.create();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    env.clock.advance(61_000);
    await env.syncAll();
    expect((await env.create()).statusCode).toBe(201);
  });
});

describe("idempotency (A12, G-11)", () => {
  it("returns the original session for a repeated key, with 200", async () => {
    const first = await env.create({ idempotencyKey: "k1", timeout: 60_000 });
    const again = await env.create({ idempotencyKey: "k1", timeout: 60_000 });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(Session.parse(again.json()).id).toBe(Session.parse(first.json()).id);
    expect(await env.db.session.count()).toBe(1);
    expect(env.nodes.a!.startCalls).toHaveLength(1);
  });

  it("treats option order and defaults as the same request", async () => {
    const first = await env.create({
      idempotencyKey: "k2",
      timeout: 60_000,
      idleTimeout: 300_000,
    });
    const again = await env.create({
      idleTimeout: 300_000,
      timeout: 60_000,
      idempotencyKey: "k2",
      waitForCapacityMs: 10,
    });
    expect(Session.parse(again.json()).id).toBe(Session.parse(first.json()).id);
  });

  it("refuses the same key with a different request", async () => {
    await env.create({ idempotencyKey: "k3", timeout: 60_000 });
    const res = await env.create({ idempotencyKey: "k3", timeout: 90_000 });
    expect(res.statusCode).toBe(409);
    expect(error(res)).toMatchObject({
      code: "conflict",
      retryable: false,
      param: "idempotencyKey",
    });
  });

  it("scopes keys to the project", async () => {
    const a = Session.parse(
      (await env.create({ idempotencyKey: "same" })).json(),
    );
    const b = Session.parse(
      (await env.create({ idempotencyKey: "same" }, env.project2.key)).json(),
    );
    expect(a.id).not.toBe(b.id);
  });

  it("frees the key when the create failed before a session existed", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    const held = Session.parse((await env.create()).json());
    expect((await env.create({ idempotencyKey: "k4" })).statusCode).toBe(503);
    await env.call("POST", `/v1/sessions/${held.id}/stop`);
    await env.nodes.a!.flushReports(env.internal);
    expect((await env.create({ idempotencyKey: "k4" })).statusCode).toBe(201);
  });

  it("forgets keys after 24 hours", async () => {
    const first = Session.parse(
      (await env.create({ idempotencyKey: "k5" })).json(),
    );
    env.clock.advance(25 * 60 * 60_000);
    await env.syncAll();
    const again = await env.create({ idempotencyKey: "k5" });
    expect(again.statusCode).toBe(201);
    expect(Session.parse(again.json()).id).not.toBe(first.id);
  });
});

describe("reading", () => {
  it("lists newest first with a cursor and a status filter", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(Session.parse((await env.create()).json()).id);
      env.clock.advance(1000);
    }
    await env.call("POST", `/v1/sessions/${ids[0]}/stop`);
    await env.nodes.a!.flushReports(env.internal);

    const p1 = ListSessionsResponse.parse(
      (await env.call("GET", "/v1/sessions?limit=2")).json(),
    );
    expect(p1.data.map((s) => s.id)).toEqual([ids[4], ids[3]]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = ListSessionsResponse.parse(
      (
        await env.call("GET", `/v1/sessions?limit=2&cursor=${p1.nextCursor}`)
      ).json(),
    );
    expect(p2.data.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    const p3 = ListSessionsResponse.parse(
      (
        await env.call("GET", `/v1/sessions?limit=2&cursor=${p2.nextCursor}`)
      ).json(),
    );
    expect(p3.data.map((s) => s.id)).toEqual([ids[0]]);
    expect(p3.nextCursor).toBeNull();

    const stopped = ListSessionsResponse.parse(
      (await env.call("GET", "/v1/sessions?status=stopped")).json(),
    );
    expect(stopped.data.map((s) => s.id)).toEqual([ids[0]]);
    expect((await env.call("GET", "/v1/sessions?limit=0")).statusCode).toBe(
      400,
    );
    expect(
      (await env.call("GET", "/v1/sessions?cursor=garbage")).statusCode,
    ).toBe(400);
  });

  it("pages a session's events in order", async () => {
    const s = Session.parse((await env.create()).json());
    const p1 = ListEventsResponse.parse(
      (await env.call("GET", `/v1/sessions/${s.id}/events?limit=2`)).json(),
    );
    expect(p1.data.map((e) => e.type)).toEqual([
      "session.requested",
      "session.scheduled",
    ]);
    const p2 = ListEventsResponse.parse(
      (
        await env.call(
          "GET",
          `/v1/sessions/${s.id}/events?limit=10&cursor=${p1.nextCursor}`,
        )
      ).json(),
    );
    expect(p2.data.map((e) => e.type)).toEqual([
      "session.starting",
      "session.ready",
    ]);
    expect(p2.nextCursor).toBeNull();
  });

  it("shows no connect url once a session is stopping or ended", async () => {
    const s = Session.parse((await env.create()).json());
    expect(s.connectUrl).not.toBeNull();
    const stopped = Session.parse(
      (await env.call("POST", `/v1/sessions/${s.id}/stop`)).json(),
    );
    expect(stopped.connectUrl).toBeNull();
  });

  it("makes stop idempotent", async () => {
    const s = Session.parse((await env.create()).json());
    const one = await env.call("POST", `/v1/sessions/${s.id}/stop`);
    const two = await env.call("POST", `/v1/sessions/${s.id}/stop`);
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(200);
    expect(env.nodes.a!.stopCalls).toHaveLength(1);
    await env.nodes.a!.flushReports(env.internal);
    const three = Session.parse(
      (await env.call("POST", `/v1/sessions/${s.id}/stop`)).json(),
    );
    expect(three.status).toBe("stopped");
  });
});
