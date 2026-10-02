import { ListEventsResponse, Session } from "@kestrel/contracts";
import { createPrisma } from "@kestrel/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
const events = (id: string) =>
  env
    .call("GET", `/v1/sessions/${id}/events?limit=1000`)
    .then((r) => ListEventsResponse.parse(r.json()).data.map((e) => e.type));

/** Advance time in steps, as the real system would see it: nodes heartbeat every 2 s, the sweeper ticks every 5 s. */
async function run(
  seconds: number,
  opts: { heartbeat?: string[]; sweep?: boolean } = {},
): Promise<void> {
  const heartbeat = opts.heartbeat ?? Object.keys(env.nodes);
  for (let t = 0; t < seconds; t += 1) {
    env.clock.advance(1_000);
    if (t % 2 === 0)
      for (const id of heartbeat) await env.nodes[id]!.sync(env.internal);
    if (opts.sweep !== false && t % 5 === 0) await env.sweeper.tick();
  }
}

describe("a lost node (K8, K10)", () => {
  it("is declared lost after 15 s of silence, once the sweeper has a full grace period", async () => {
    const s = Session.parse((await env.create()).json());
    await run(10); // everyone healthy; sweeper connected for 10 s
    expect((await node("a")).state).toBe("active");

    await run(14, { heartbeat: [] }); // node a goes quiet
    // the sweeper has been connected for 24 s by now, and a has been silent for 14 s: not yet
    expect((await node("a")).state).toBe("active");
    await run(4, { heartbeat: [] });
    const lost = await node("a");
    expect(lost).toMatchObject({ state: "lost", fenced: true, epoch: 2 });
    expect(await row(s.id)).toMatchObject({
      status: "failed",
      endReason: "node_lost",
      connectUrl: null,
    });
    expect(await events(s.id)).toEqual([
      "session.requested",
      "session.scheduled",
      "session.starting",
      "session.ready",
      "node.lost",
      "session.stopping",
      "session.ended",
    ]);
  });

  it("stays fenced after it returns until it holds nothing the API ended, with a new epoch", async () => {
    const ended = Session.parse((await env.create()).json());
    await run(10);
    await run(20, { heartbeat: [] });
    expect((await node("a")).state).toBe("lost");
    expect((await env.create()).statusCode).toBe(503); // fenced: no capacity offered

    // The node comes back, still holding the session the API ended, with its old epoch.
    const a = env.nodes.a!;
    expect(a.epoch).toBe(1);
    const first = await a.heartbeat(env.internal);
    expect(first).toMatchObject({
      epoch: 2,
      fenced: true,
      stop: [{ sessionId: ended.id, reason: "node_lost" }],
    });
    expect(a.epoch).toBe(2); // adopted
    expect(a.held.size).toBe(0); // and stopped it
    expect((await node("a")).fenced).toBe(true);
    expect((await env.create()).statusCode).toBe(503);

    // Next heartbeat: it holds none of what the API ended, with the new epoch. The fence lifts.
    const second = await a.sync(env.internal);
    expect(second).toMatchObject({
      epoch: 2,
      fenced: false,
      stop: [],
      unknown: [],
    });
    expect(await node("a")).toMatchObject({
      state: "active",
      fenced: false,
      lostAt: null,
    });
    const fresh = await env.create();
    expect(fresh.statusCode).toBe(201);
    expect(env.nodes.a!.startCalls.at(-1)?.epoch).toBe(2);
  });

  it("fails over: new sessions go to the other node while one is fenced", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    const onA = await Promise.all(
      Array.from({ length: 4 }, () => env.create()),
    );
    expect(onA.every((r) => r.statusCode === 201)).toBe(true);
    await run(10);
    await run(20, { heartbeat: ["b"] }); // a goes silent
    expect((await node("a")).state).toBe("lost");
    expect((await node("b")).state).toBe("active");
    const created = Session.parse((await env.create()).json());
    expect(created.nodeId).toBe("b");
    for (const r of onA) {
      const s = Session.parse(r.json());
      if (s.nodeId === "a")
        expect(await row(s.id)).toMatchObject({
          status: "failed",
          endReason: "node_lost",
        });
    }
  });

  it("completes the stop of a session that was stopping when its node was lost, keeping its reason", async () => {
    const s = Session.parse((await env.create()).json());
    env.failpoints.set("api.node_stop", "drop:once");
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    await run(10);
    await run(20, { heartbeat: [] });
    expect(await row(s.id)).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
    });
  });
});

describe("the grace period (K8)", () => {
  it("does not fail a node that looks silent only because the sweeper just started", async () => {
    const s = Session.parse((await env.create()).json());
    env.clock.advance(30_000); // the node's last heartbeat is 30 s old; the sweeper is new
    await env.sweeper.tick();
    expect((await node("a")).state).toBe("active");
    env.clock.advance(5_000);
    await env.sweeper.tick();
    expect((await node("a")).state).toBe("active"); // 5 s of connectivity
    await env.nodes.a!.heartbeat(env.internal);
    env.clock.advance(11_000);
    await env.sweeper.tick(); // 16 s of connectivity, but the node has heartbeated
    expect((await node("a")).state).toBe("active");
    expect((await row(s.id)).status).toBe("ready");
  });

  it("still fails a node that stays silent after the grace has passed", async () => {
    await env.sweeper.tick();
    env.clock.advance(16_000);
    await env.sweeper.tick();
    expect((await node("a")).state).toBe("lost");
  });
});

describe("a database outage (K8)", () => {
  async function outage(seconds: number): Promise<void> {
    const broken = createPrisma(
      "postgresql://kestrel:kestrel@127.0.0.1:1/none",
      { max: 1 },
    );
    const real = env.ctx.db;
    env.ctx.db = broken;
    try {
      for (let t = 0; t < seconds; t++) {
        env.clock.advance(1_000);
        if (t % 5 === 0) await env.sweeper.tick(); // fails: the database is unreachable
        if (t % 2 === 0)
          await env.nodes.a!.heartbeat(env.internal).catch(() => undefined); // cannot be recorded
      }
    } finally {
      env.ctx.db = real;
      await broken.$disconnect();
    }
  }

  for (const seconds of [5, 20, 60]) {
    it(`of ${seconds} s fails no session and declares no node lost`, async () => {
      const s = Session.parse((await env.create()).json());
      await run(10);
      await outage(seconds);
      // The database is back. The node's last recorded heartbeat is old; the sweeper's grace restarts.
      await env.sweeper.tick();
      expect((await node("a")).state).toBe("active");
      await run(20); // normal operation resumes
      expect((await node("a")).state).toBe("active");
      expect(await row(s.id)).toMatchObject({
        status: "ready",
        endReason: null,
      });
    });
  }

  it("resets the sweeper's grace each time the database fails", async () => {
    await run(20);
    expect(env.sweeper.connectedForMs).toBeGreaterThanOrEqual(15_000);
    await outage(6);
    expect(env.sweeper.connectedForMs).toBeNull();
  });
});

describe("sweeper leadership (K9)", () => {
  it("does nothing while another process holds the lock, and works once it is released", async () => {
    const s = Session.parse((await env.create()).json());
    env.failpoints.set("api.create.before_ready", "throw:once");
    await env.create(); // strands a session in `starting`
    env.clock.advance(46_000);
    await env.nodes.a!.heartbeat(env.internal);

    await env.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1263424340::bigint)`;
      await env.sweeper.tick(); // another leader holds the lock: this tick is a no-op
      expect(env.sweeper.connectedForMs).toBeNull();
      expect(
        await env.db.session.count({ where: { status: "starting" } }),
      ).toBe(1);
    });
    await env.sweeper.tick();
    expect(await env.db.session.count({ where: { status: "starting" } })).toBe(
      0,
    );
    expect((await row(s.id)).status).toBe("ready");
  });
});
