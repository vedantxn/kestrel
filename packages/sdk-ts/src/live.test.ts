import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, Kestrel } from "./index.js";
import { SESSION_ID, apiError, fakeApi } from "./test/fake-api.js";

// Tokens and live view (W1, W2), /computer (W4) and /recording (W3).

let api: Awaited<ReturnType<typeof fakeApi>>;
let kestrel: Kestrel;
let dir: string;

beforeEach(async () => {
  api = await fakeApi();
  kestrel = new Kestrel({
    apiKey: "ksl_test",
    baseUrl: api.url,
    retryBaseDelayMs: 1,
  });
  dir = await mkdtemp(join(tmpdir(), "kestrel-sdk-"));
});
afterEach(async () => {
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

const viewer = `https://kestrel.test/live/${SESSION_ID}#ws=x&token=t`;
const token = (scope: string) => ({
  status: 201,
  body: {
    scope,
    token: "t",
    url: viewer,
    expiresAt: "2026-10-03T10:10:00.000Z",
  },
});

describe("tokens and live view", () => {
  it("mints a token with the request as given", async () => {
    api.on("POST", `/v1/sessions/${SESSION_ID}/tokens`, token("cdp"));
    const t = await kestrel.sessions.mintToken(SESSION_ID, {
      scope: "cdp",
      singleUse: true,
    });
    expect(t.scope).toBe("cdp");
    expect(api.requests[0]!.body).toEqual({ scope: "cdp", singleUse: true });
  });

  it("liveViewUrl asks for a view token by default and control when told", async () => {
    api.on("POST", `/v1/sessions/${SESSION_ID}/tokens`, token("view"));
    expect(await kestrel.sessions.liveViewUrl(SESSION_ID)).toBe(viewer);
    await kestrel.sessions.liveViewUrl(SESSION_ID, {
      control: true,
      ttlMs: 60_000,
    });
    expect(api.requests.map((r) => r.body)).toEqual([
      { scope: "view" },
      { scope: "control", ttlMs: 60_000 },
    ]);
  });
});

describe("computer", () => {
  it("sends one action and returns the answer", async () => {
    api.on("POST", `/v1/sessions/${SESSION_ID}/computer`, {
      status: 200,
      body: {
        ok: true,
        screenshot: "iVBORw0KGgo=",
        width: 1280,
        height: 720,
        url: "https://example.com/",
      },
    });
    const r = await kestrel.sessions.computer(SESSION_ID, {
      action: "click",
      x: 10,
      y: 20,
      screenshot: true,
    });
    expect(r).toMatchObject({
      ok: true,
      width: 1280,
      screenshot: "iVBORw0KGgo=",
    });
    expect(api.requests[0]!.body).toEqual({
      action: "click",
      x: 10,
      y: 20,
      screenshot: true,
    });
  });

  it("surfaces conflict when the session is not running", async () => {
    const notRunning = apiError("conflict", "The session is not running.");
    notRunning.error.retryable = false;
    api.on("POST", `/v1/sessions/${SESSION_ID}/computer`, {
      status: 409,
      body: notRunning,
    });
    await expect(
      kestrel.sessions.computer(SESSION_ID, { action: "screenshot" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("recording", () => {
  const video = Buffer.from("\0\0\0\x18ftypisom-fragments-of-video");

  it("streams the body, after retrying a failure before it starts", async () => {
    api.on(
      "GET",
      `/v1/sessions/${SESSION_ID}/recording`,
      { status: 500, body: apiError("internal", "node unreachable") },
      { status: 200, body: video },
    );
    const stream = await kestrel.sessions.recording(SESSION_ID);
    const bytes = Buffer.from(await new Response(stream).arrayBuffer());
    expect(bytes.equals(video)).toBe(true);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]!.headers.accept).toContain("*/*");
  });

  it("raises not_found as an ApiError", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}/recording`, {
      status: 404,
      body: apiError("not_found", "This session was not recorded."),
    });
    await expect(kestrel.sessions.recording(SESSION_ID)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("saveRecording writes the file and returns its size", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}/recording`, {
      status: 200,
      body: video,
    });
    const path = join(dir, "out.mp4");
    expect(await kestrel.sessions.saveRecording(SESSION_ID, path)).toBe(
      video.length,
    );
    expect((await readFile(path)).equals(video)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("saveRecording leaves no file when the recording is missing", async () => {
    api.on("GET", `/v1/sessions/${SESSION_ID}/recording`, {
      status: 404,
      body: apiError("not_found", "This session was not recorded."),
    });
    const path = join(dir, "out.mp4");
    await expect(
      kestrel.sessions.saveRecording(SESSION_ID, path),
    ).rejects.toBeInstanceOf(ApiError);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });
});
