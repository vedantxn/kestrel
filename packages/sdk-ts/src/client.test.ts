import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  ConnectionError,
  Kestrel,
  KestrelError,
  SessionEndedError,
  type SessionEvent,
} from "./index.js";
import { retryAfterMs } from "./http.js";
import { SESSION_ID, apiError, fakeApi, fakeSession } from "./test/fake-api.js";

let api: Awaited<ReturnType<typeof fakeApi>>;
let kestrel: Kestrel;

beforeEach(async () => {
  api = await fakeApi();
  kestrel = new Kestrel({
    apiKey: "ksl_test",
    baseUrl: api.url,
    retryBaseDelayMs: 1,
  });
});
afterEach(() => api.close());

function event(
  n: number,
  body: Pick<SessionEvent, "type" | "data">,
): SessionEvent {
  return {
    id: `evt_${n}`,
    sessionId: SESSION_ID,
    at: `2026-10-03T10:00:0${n}.000Z`,
    ...body,
  } as SessionEvent;
}

describe("configuration", () => {
  it("reads the key and URL from the environment", () => {
    const before = { ...process.env };
    process.env.KESTREL_API_KEY = "ksl_env";
    process.env.KESTREL_URL = "https://kestrel.example/api";
    try {
      expect(new Kestrel().baseUrl).toBe("https://kestrel.example/api/");
    } finally {
      process.env = before;
    }
  });

  it("refuses to start without an API key", () => {
    const before = { ...process.env };
    delete process.env.KESTREL_API_KEY;
    try {
      expect(() => new Kestrel({ baseUrl: api.url })).toThrow(KestrelError);
    } finally {
      process.env = before;
    }
  });

  it("keeps a path prefix in the base URL", async () => {
    api.on("GET", `/prefix/v1/sessions/${SESSION_ID}`, {
      status: 200,
      body: fakeSession(),
    });
    const k = new Kestrel({ apiKey: "ksl_test", baseUrl: `${api.url}/prefix` });
    expect((await k.sessions.get(SESSION_ID)).id).toBe(SESSION_ID);
  });
});

describe("sessions", () => {
  it("creates a session with the options, a bearer key and an idempotency key", async () => {
    api.on("POST", "/v1/sessions", { status: 201, body: fakeSession() });
    const s = await kestrel.sessions.create({
      timeout: 60_000,
      viewport: { width: 800, height: 600 },
      network: { allow: ["example.com"] },
    });
    expect(s.id).toBe(SESSION_ID);
    const req = api.requests[0]!;
    expect(req.headers.authorization).toBe("Bearer ksl_test");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toMatchObject({
      timeout: 60_000,
      viewport: { width: 800, height: 600 },
      network: { allow: ["example.com"] },
    });
    expect((req.body as { idempotencyKey: string }).idempotencyKey).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("uses the caller's idempotency key when given one", async () => {
    api.on("POST", "/v1/sessions", { status: 200, body: fakeSession() });
    await kestrel.sessions.create({ idempotencyKey: "mine" });
    expect(api.requests[0]!.body).toEqual({ idempotencyKey: "mine" });
  });

  it("gets, stops and lists", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}`, {
      status: 200,
      body: fakeSession(),
    });
    api.on("POST", `/v1/sessions/${SESSION_ID}/stop`, {
      status: 200,
      body: fakeSession({ status: "stopping", connectUrl: null }),
    });
    api.on("GET", "/v1/sessions", {
      status: 200,
      body: { data: [fakeSession()], nextCursor: "abc" },
    });

    expect((await kestrel.sessions.get(SESSION_ID)).status).toBe("ready");
    expect((await kestrel.sessions.stop(SESSION_ID)).status).toBe("stopping");
    const page = await kestrel.sessions.list({ status: "ready", limit: 5 });
    expect(page.nextCursor).toBe("abc");
    expect(page.data).toHaveLength(1);
    const listReq = api.requests[2]!;
    expect(listReq.query.get("status")).toBe("ready");
    expect(listReq.query.get("limit")).toBe("5");
    expect(listReq.query.has("cursor")).toBe(false);
    expect(api.requests[1]!.body).toBeUndefined();
  });
});

describe("errors and retries", () => {
  it("throws the API's error code without retrying a non-retryable error", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}`, {
      status: 404,
      body: apiError("not_found", "No such session."),
    });
    const err = await kestrel.sessions.get(SESSION_ID).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 404,
      code: "not_found",
      retryable: false,
      requestId: "req-1",
    });
    expect(api.requests).toHaveLength(1);
  });

  it("carries `param` on invalid_request", async () => {
    api.on("POST", "/v1/sessions", {
      status: 400,
      body: apiError("invalid_request", "too long", "timeout"),
    });
    await expect(kestrel.sessions.create({ timeout: 1 })).rejects.toMatchObject(
      { code: "invalid_request", param: "timeout" },
    );
  });

  it("retries capacity_exhausted with the same idempotency key, then succeeds", async () => {
    const full = { status: 503, body: apiError("capacity_exhausted", "full") };
    api.on("POST", "/v1/sessions", full, full, {
      status: 201,
      body: fakeSession(),
    });
    const s = await kestrel.sessions.create({ waitForCapacityMs: 1000 });
    expect(s.id).toBe(SESSION_ID);
    expect(api.requests).toHaveLength(3);
    const keys = api.requests.map(
      (r) => (r.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    api.on("POST", "/v1/sessions", {
      status: 503,
      body: apiError("capacity_exhausted", "full"),
    });
    const k = new Kestrel({
      apiKey: "ksl_test",
      baseUrl: api.url,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });
    await expect(k.sessions.create()).rejects.toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
    });
    expect(api.requests).toHaveLength(3);
  });

  it("waits as long as Retry-After says on 429", async () => {
    api.on(
      "POST",
      "/v1/sessions",
      {
        status: 429,
        body: apiError("quota_exceeded", "slow down"),
        headers: { "retry-after": "1" },
      },
      { status: 201, body: fakeSession() },
    );
    const t0 = Date.now();
    await kestrel.sessions.create();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(api.requests).toHaveLength(2);
  });

  it("retries a create whose key is still in progress, but not a key reused with another body", async () => {
    api.on(
      "POST",
      "/v1/sessions",
      { status: 409, body: apiError("conflict", "still in progress") },
      { status: 200, body: fakeSession() },
    );
    await kestrel.sessions.create({ idempotencyKey: "k" });
    expect(api.requests).toHaveLength(2);

    const reused = apiError("conflict", "different request", "idempotencyKey");
    reused.error.retryable = false;
    api.on("POST", "/v1/sessions", { status: 409, body: reused });
    await expect(
      kestrel.sessions.create({ idempotencyKey: "k", timeout: 5000 }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    expect(api.requests).toHaveLength(3);
  });

  it("reports a body that is not the error shape as malformed_response", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}`, {
      status: 418,
      body: "teapot",
    });
    await expect(kestrel.sessions.get(SESSION_ID)).rejects.toMatchObject({
      code: "malformed_response",
      retryable: false,
    });
  });

  it("retries a refused connection and then reports it", async () => {
    await api.close();
    const k = new Kestrel({
      apiKey: "ksl_test",
      baseUrl: api.url,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });
    await expect(k.sessions.get(SESSION_ID)).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  it("stops retrying when the caller aborts", async () => {
    api.on("POST", "/v1/sessions", {
      status: 503,
      body: apiError("capacity_exhausted", "full"),
      headers: { "retry-after": "30" },
    });
    const ac = new AbortController();
    const p = kestrel.sessions.create({}, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("cancelled")), 50);
    await expect(p).rejects.toThrow("cancelled");
    expect(api.requests).toHaveLength(1);
  });

  it("parses Retry-After as seconds or a date", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    const inFiveSeconds = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs(inFiveSeconds)).toBeGreaterThan(3000);
  });
});

describe("waitUntilReady", () => {
  it("polls until the session is ready", async () => {
    api.on(
      "GET",
      `/v1/sessions/${SESSION_ID}`,
      { status: 200, body: fakeSession({ status: "starting" }) },
      { status: 200, body: fakeSession({ status: "active" }) },
    );
    const s = await kestrel.sessions.waitUntilReady(SESSION_ID, {
      pollIntervalMs: 1,
    });
    expect(s.status).toBe("active");
  });

  it("throws SessionEndedError when the session ends first", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}`, {
      status: 200,
      body: fakeSession({ status: "failed", endReason: "start_timeout" }),
    });
    await expect(
      kestrel.sessions.waitUntilReady(SESSION_ID),
    ).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("gives up after its timeout", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}`, {
      status: 200,
      body: fakeSession({ status: "starting" }),
    });
    await expect(
      kestrel.sessions.waitUntilReady(SESSION_ID, {
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/still starting/);
  });
});

describe("iterEvents", () => {
  it("walks every page", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}/events`, (req) =>
      req.query.get("cursor") === "p2"
        ? {
            status: 200,
            body: {
              data: [event(2, { type: "session.starting", data: {} })],
              nextCursor: null,
            },
          }
        : {
            status: 200,
            body: {
              data: [event(1, { type: "session.requested", data: {} })],
              nextCursor: "p2",
            },
          },
    );
    const seen: string[] = [];
    for await (const e of kestrel.sessions.iterEvents(SESSION_ID))
      seen.push(e.type);
    expect(seen).toEqual(["session.requested", "session.starting"]);
  });

  it("follows new events without repeating old ones, and stops when the session ends", async () => {
    const e1 = event(1, { type: "session.requested", data: {} });
    const e2 = event(2, {
      type: "session.ready",
      data: { startPath: "hot", readyMs: 900 },
    });
    const e3 = event(3, {
      type: "session.ended",
      data: { endReason: "client_stop", status: "stopped" },
    });
    const page = (...data: SessionEvent[]) => ({
      status: 200,
      body: { data, nextCursor: null },
    });
    api.on(
      "GET",
      `/v1/sessions/${SESSION_ID}/events`,
      page(e1),
      page(e1),
      page(e1, e2),
      page(e1, e2, e3),
    );
    const seen: string[] = [];
    for await (const e of kestrel.sessions.iterEvents(SESSION_ID, {
      follow: true,
      pollIntervalMs: 1,
    }))
      seen.push(e.id);
    expect(seen).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(api.requests).toHaveLength(4);
  });
});
