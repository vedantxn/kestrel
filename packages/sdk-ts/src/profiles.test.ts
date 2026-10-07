import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConnectionError,
  Kestrel,
  isProfileBusy,
  type Profile,
} from "./index.js";
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

const PROFILE_ID = "prf_01k6e4m9t8f2xq3w5y7z9a1b2c";

function fakeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    name: "work",
    metadata: {},
    version: 0,
    bytes: 0,
    savedAt: null,
    savedBySessionId: null,
    chromeMajor: null,
    inUseBy: null,
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

/** The API's answer while another session is saving into the profile. */
const busy = {
  status: 409,
  body: apiError(
    "conflict",
    "Another session is saving into this profile; only one may at a time.",
    "profile.id",
  ),
};

describe("profiles", () => {
  it("creates, gets, lists and deletes", async () => {
    api.on("POST", "/v1/profiles", { status: 201, body: fakeProfile() });
    api.on("GET", `/v1/profiles/${PROFILE_ID}`, {
      status: 200,
      body: fakeProfile({ version: 2, bytes: 4096 }),
    });
    api.on("GET", "/v1/profiles", {
      status: 200,
      body: { data: [fakeProfile()], nextCursor: "next" },
    });
    api.on("DELETE", `/v1/profiles/${PROFILE_ID}`, { status: 204 });

    const p = await kestrel.profiles.create({
      name: "work",
      metadata: { team: "a" },
    });
    expect(p.id).toBe(PROFILE_ID);
    expect(api.requests[0]!.body).toEqual({
      name: "work",
      metadata: { team: "a" },
    });
    expect(api.requests[0]!.headers.authorization).toBe("Bearer ksl_test");

    expect(await kestrel.profiles.get(PROFILE_ID)).toMatchObject({
      version: 2,
      bytes: 4096,
    });

    const page = await kestrel.profiles.list({ limit: 5, cursor: "c1" });
    expect(page.nextCursor).toBe("next");
    expect(page.data.map((x) => x.id)).toEqual([PROFILE_ID]);
    expect(api.requests[2]!.query.get("limit")).toBe("5");
    expect(api.requests[2]!.query.get("cursor")).toBe("c1");

    expect(await kestrel.profiles.delete(PROFILE_ID)).toBeUndefined();
    expect(api.requests[3]!.method).toBe("DELETE");
  });

  it("sends an empty create body by default, and lists with no query", async () => {
    api.on("POST", "/v1/profiles", { status: 201, body: fakeProfile() });
    api.on("GET", "/v1/profiles", {
      status: 200,
      body: { data: [], nextCursor: null },
    });
    await kestrel.profiles.create();
    expect(api.requests[0]!.body).toEqual({});
    await kestrel.profiles.list();
    expect([...api.requests[1]!.query.keys()]).toEqual([]);
  });

  it("throws the deployment's refusal when profiles are not configured", async () => {
    api.on("GET", "/v1/profiles", {
      status: 400,
      body: apiError(
        "invalid_request",
        "Profiles are not configured on this deployment.",
      ),
    });
    await expect(kestrel.profiles.list()).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    expect(api.requests).toHaveLength(1);
  });

  it("retries a create the API says changed nothing", async () => {
    api.on(
      "POST",
      "/v1/profiles",
      { status: 500, body: apiError("internal", "try again") },
      { status: 201, body: fakeProfile() },
    );
    expect((await kestrel.profiles.create({ name: "work" })).id).toBe(
      PROFILE_ID,
    );
    expect(api.requests).toHaveLength(2);
  });

  it("does not repeat a create that got no answer, since it may have made the profile", async () => {
    let calls = 0;
    const k = new Kestrel({
      apiKey: "ksl_test",
      baseUrl: api.url,
      retryBaseDelayMs: 1,
      fetch: (async () => {
        calls++;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(k.profiles.create({ name: "work" })).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(calls).toBe(1);
    // Reads are still retried.
    await expect(k.profiles.get(PROFILE_ID)).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(calls).toBe(1 + 4);
  });

  it("does not repeat a create answered by something other than the API", async () => {
    api.on("POST", "/v1/profiles", { status: 502, body: "bad gateway" });
    await expect(kestrel.profiles.create()).rejects.toMatchObject({
      code: "malformed_response",
      retryable: true,
    });
    expect(api.requests).toHaveLength(1);
  });
});

describe("sessions with a profile", () => {
  it("sends the profile option", async () => {
    api.on("POST", "/v1/sessions", { status: 201, body: fakeSession() });
    await kestrel.sessions.create({
      profile: { id: PROFILE_ID, persist: true },
    });
    expect(api.requests[0]!.body).toMatchObject({
      profile: { id: PROFILE_ID, persist: true },
    });
  });

  it("throws a busy profile at once unless asked to wait", async () => {
    api.on("POST", "/v1/sessions", busy, {
      status: 201,
      body: fakeSession(),
    });
    const err = await kestrel.sessions
      .create({ profile: { id: PROFILE_ID, persist: true } })
      .catch((e: unknown) => e);
    expect(isProfileBusy(err)).toBe(true);
    expect(err).toMatchObject({
      status: 409,
      code: "conflict",
      param: "profile.id",
      retryable: true,
    });
    expect(api.requests).toHaveLength(1);
  });

  it("with waitForProfileMs, retries a busy profile with the same idempotency key until it is free", async () => {
    // More busy answers than maxRetries (3): the wait is bounded by time, not by the retry count.
    api.on("POST", "/v1/sessions", busy, busy, busy, busy, busy, {
      status: 201,
      body: fakeSession(),
    });
    const s = await kestrel.sessions.create(
      { profile: { id: PROFILE_ID, persist: true } },
      { waitForProfileMs: 10_000 },
    );
    expect(s.id).toBe(SESSION_ID);
    expect(api.requests).toHaveLength(6);
    const keys = api.requests.map(
      (r) => (r.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("with waitForProfileMs, gives up at the deadline and throws the conflict", async () => {
    api.on("POST", "/v1/sessions", busy);
    const t0 = Date.now();
    const err = await kestrel.sessions
      .create(
        { profile: { id: PROFILE_ID, persist: true } },
        { waitForProfileMs: 100 },
      )
      .catch((e: unknown) => e);
    expect(isProfileBusy(err)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(api.requests.length).toBeGreaterThan(1);
  });

  it("with waitForProfileMs, does not wait on other conflicts", async () => {
    const tooOld = apiError(
      "conflict",
      "No browser node runs a Chrome new enough for this profile.",
      "profile.id",
    );
    tooOld.error.retryable = false;
    api.on("POST", "/v1/sessions", { status: 409, body: tooOld });
    await expect(
      kestrel.sessions.create(
        { profile: { id: PROFILE_ID } },
        { waitForProfileMs: 10_000 },
      ),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    expect(api.requests).toHaveLength(1);
  });

  it("stops waiting when the caller aborts", async () => {
    api.on("POST", "/v1/sessions", {
      ...busy,
      headers: { "retry-after": "30" },
    });
    const ac = new AbortController();
    const p = kestrel.sessions.create(
      { profile: { id: PROFILE_ID, persist: true } },
      { waitForProfileMs: 60_000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(new Error("cancelled")), 50);
    await expect(p).rejects.toThrow("cancelled");
    expect(api.requests).toHaveLength(1);
  });
});
