import {
  ComputerResponse,
  ErrorResponse,
  Session,
  SessionToken,
} from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
beforeEach(async () => {
  await env?.close();
  env = await makeEnv();
});
afterAll(async () => env?.close());

const post = (url: string, body: unknown, key = env.key) =>
  env.api.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });

async function running(): Promise<Session> {
  const res = await env.create();
  expect(res.statusCode).toBe(201);
  return Session.parse(res.json());
}

describe("POST /v1/sessions/{id}/tokens (W1)", () => {
  it("mints a view token for the viewer page, with the token only in the fragment", async () => {
    const s = await running();
    const res = await post(`/v1/sessions/${s.id}/tokens`, { scope: "view" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const t = SessionToken.parse(res.json());
    const url = new URL(t.url);
    expect(url.pathname).toBe(`/live/${s.id}`);
    expect(url.search).toBe("");
    const frag = new URLSearchParams(url.hash.slice(1));
    expect(frag.get("token")).toBe(t.token);
    expect(frag.get("ws")).toMatch(
      new RegExp(`^wss://.+/v1/sessions/${s.id}/live$`),
    );
    const v = await env.verifier.verify(t.token, env.clock.now(), "view");
    expect(v.ok).toBe(true);
    // Ten minutes by default.
    expect(Date.parse(t.expiresAt) - env.clock.now()).toBeLessThanOrEqual(
      600_000,
    );
    expect(Date.parse(t.expiresAt) - env.clock.now()).toBeGreaterThan(590_000);
  });

  it("mints a control token with a chosen TTL, and caps single-use ones at five minutes", async () => {
    const s = await running();
    const c = SessionToken.parse(
      (
        await post(`/v1/sessions/${s.id}/tokens`, {
          scope: "control",
          ttlMs: 60_000,
        })
      ).json(),
    );
    expect(Date.parse(c.expiresAt) - env.clock.now()).toBeLessThanOrEqual(
      60_000,
    );
    const once = SessionToken.parse(
      (
        await post(`/v1/sessions/${s.id}/tokens`, {
          scope: "view",
          ttlMs: 3_600_000,
          singleUse: true,
        })
      ).json(),
    );
    expect(Date.parse(once.expiresAt) - env.clock.now()).toBeLessThanOrEqual(
      300_000,
    );
    const v = await env.verifier.verify(once.token, env.clock.now(), "view");
    expect(v.ok && v.claims.once).toBe(true);
  });

  it("re-issues a cdp token as a connect URL", async () => {
    const s = await running();
    const t = SessionToken.parse(
      (await post(`/v1/sessions/${s.id}/tokens`, { scope: "cdp" })).json(),
    );
    expect(t.url).toMatch(
      new RegExp(`^wss://.+/v1/sessions/${s.id}/cdp\\?token=`),
    );
    expect(
      (await env.verifier.verify(t.token, env.clock.now(), "cdp")).ok,
    ).toBe(true);
  });

  it("refuses a stopped session, another project's session, and bad input", async () => {
    const s = await running();
    expect(
      (
        await post(
          `/v1/sessions/${s.id}/tokens`,
          { scope: "view" },
          env.project2.key,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await post(`/v1/sessions/${s.id}/tokens`, { scope: "admin" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(`/v1/sessions/${s.id}/tokens`, { scope: "view", ttlMs: 5 }))
        .statusCode,
    ).toBe(400);
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    const res = await post(`/v1/sessions/${s.id}/tokens`, { scope: "view" });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error).toMatchObject({
      code: "conflict",
      retryable: false,
    });
  });
});

describe("POST /v1/sessions/{id}/computer (W4)", () => {
  it("passes one action to the session's node and returns its answer", async () => {
    const s = await running();
    const res = await post(`/v1/sessions/${s.id}/computer`, {
      action: "screenshot",
    });
    expect(res.statusCode).toBe(200);
    expect(ComputerResponse.parse(res.json()).screenshot).toBeTruthy();
    const click = await post(`/v1/sessions/${s.id}/computer`, {
      action: "click",
      x: 10,
      y: 20,
    });
    expect(ComputerResponse.parse(click.json()).screenshot).toBeUndefined();
    expect(env.nodeClient.computerCalls.at(-1)).toEqual({
      action: "click",
      x: 10,
      y: 20,
      button: "left",
      clicks: 1,
      screenshot: false,
    });
  });

  it("validates the action", async () => {
    const s = await running();
    for (const bad of [
      { action: "drag" },
      { action: "click", x: -1, y: 0 },
      { action: "type", text: "" },
      { action: "type", text: "x".repeat(10_001) },
      { action: "screenshot", extra: 1 },
    ])
      expect(
        (await post(`/v1/sessions/${s.id}/computer`, bad)).statusCode,
      ).toBe(400);
  });

  it("refuses a session that is not running or not yours", async () => {
    const s = await running();
    expect(
      (
        await post(
          `/v1/sessions/${s.id}/computer`,
          { action: "screenshot" },
          env.project2.key,
        )
      ).statusCode,
    ).toBe(404);
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    expect(
      (await post(`/v1/sessions/${s.id}/computer`, { action: "screenshot" }))
        .statusCode,
    ).toBe(409);
  });
});

describe("the live-view page (W2)", () => {
  it("is served without a key, with no referrer and a strict CSP", async () => {
    const res = await env.api.inject({
      method: "GET",
      url: "/live/ses_0000000000000000000000000a",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(res.headers["content-security-policy"])).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.body).toContain("Kestrel live view");
  });
});
