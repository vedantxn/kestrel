import {
  SESSION_STATUSES,
  TRANSITIONS,
  type SessionStatus,
} from "@kestrel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newUuid } from "./ids.js";
import { transition } from "./lifecycle.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env?.close());

async function sessionIn(status: SessionStatus): Promise<string> {
  const key = await env.db.apiKey.findFirstOrThrow();
  const id = newUuid();
  await env.db.session.create({
    data: {
      id,
      projectId: env.projectId,
      apiKeyId: key.id,
      status,
      options: {},
      nodeId: "a",
      nodeEpoch: 1,
    },
  });
  return id;
}

const statusOf = async (id: string) =>
  (await env.db.session.findUniqueOrThrow({ where: { id } })).status;

describe("every session status pair (K11)", () => {
  for (const from of SESSION_STATUSES) {
    for (const to of SESSION_STATUSES) {
      const legal = TRANSITIONS[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "applied" : "refused"}`, async () => {
        const id = await sessionIn(from);
        const attempt = env.db.$transaction((tx) =>
          transition(tx, {
            id,
            from: [from],
            to,
            events: [{ type: "session.starting", data: {} }],
            at: new Date(),
          }),
        );
        if (legal) {
          await expect(attempt).resolves.toBe(true);
          expect(await statusOf(id)).toBe(to);
          expect(
            await env.db.sessionEvent.count({ where: { sessionId: id } }),
          ).toBe(1);
        } else {
          await expect(attempt).rejects.toThrow(/illegal session transition/);
          expect(await statusOf(id)).toBe(from);
          expect(
            await env.db.sessionEvent.count({ where: { sessionId: id } }),
          ).toBe(0);
        }
      });
    }
  }

  it("is conditional: it does nothing, and writes no event, if the status changed underneath it", async () => {
    const id = await sessionIn("ready");
    const won = await env.db.$transaction((tx) =>
      transition(tx, {
        id,
        from: ["ready"],
        to: "stopping",
        events: [{ type: "session.starting", data: {} }],
        at: new Date(),
      }),
    );
    expect(won).toBe(true);
    const lost = await env.db.$transaction((tx) =>
      transition(tx, {
        id,
        from: ["ready"],
        to: "active",
        events: [{ type: "session.starting", data: {} }],
        at: new Date(),
      }),
    );
    expect(lost).toBe(false);
    expect(await statusOf(id)).toBe("stopping");
    expect(await env.db.sessionEvent.count({ where: { sessionId: id } })).toBe(
      1,
    );
  });

  it("lets exactly one of many concurrent actors win", async () => {
    const id = await sessionIn("ready");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        env.db.$transaction((tx) =>
          transition(tx, {
            id,
            from: ["ready"],
            to: "stopping",
            events: [{ type: "session.starting", data: {} }],
            at: new Date(),
          }),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await env.db.sessionEvent.count({ where: { sessionId: id } })).toBe(
      1,
    );
  });
});
