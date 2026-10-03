import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kestrel } from "./index.js";
import { SESSION_ID, fakeApi, fakeSession } from "./test/fake-api.js";

// Playwright is replaced so the test needs no browser: what matters here is the order of
// create, connect, close and stop, and that a failure never leaves a session running.
const pw = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  browserClose: vi.fn(),
}));
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: pw.connectOverCDP },
}));

let api: Awaited<ReturnType<typeof fakeApi>>;
let kestrel: Kestrel;

beforeEach(async () => {
  pw.connectOverCDP.mockReset();
  pw.browserClose.mockReset().mockResolvedValue(undefined);
  api = await fakeApi();
  api.on("POST", "/v1/sessions", { status: 201, body: fakeSession() });
  api.on("POST", `/v1/sessions/${SESSION_ID}/stop`, {
    status: 200,
    body: fakeSession({ status: "stopping", connectUrl: null }),
  });
  kestrel = new Kestrel({ apiKey: "ksl_test", baseUrl: api.url });
});
afterEach(() => api.close());

const calls = () => api.requests.map((r) => `${r.method} ${r.path}`);

describe("connect", () => {
  it("creates a session and attaches Playwright to its connectUrl", async () => {
    const browser = { close: pw.browserClose };
    pw.connectOverCDP.mockResolvedValue(browser);
    const k = await kestrel.connect({ timeout: 60_000 });
    expect(k.browser).toBe(browser);
    expect(k.session.id).toBe(SESSION_ID);
    expect(pw.connectOverCDP).toHaveBeenCalledWith(fakeSession().connectUrl, {
      timeout: 30_000,
    });
    expect(api.requests[0]!.body).toMatchObject({ timeout: 60_000 });
    expect(api.requests[0]!.body).not.toHaveProperty("connectTimeoutMs");
    expect(calls()).toEqual(["POST /v1/sessions"]);
  });

  it("close() closes the browser, then stops the session, once", async () => {
    const order: string[] = [];
    pw.browserClose.mockImplementation(async () => {
      order.push("browser.close");
    });
    pw.connectOverCDP.mockResolvedValue({ close: pw.browserClose });
    const k = await kestrel.connect();
    await Promise.all([k.close(), k.close()]);
    order.push(...calls().slice(1));
    expect(order).toEqual([
      "browser.close",
      `POST /v1/sessions/${SESSION_ID}/stop`,
    ]);
  });

  it("close() still stops the session when the browser is already gone", async () => {
    pw.browserClose.mockRejectedValue(new Error("Target closed"));
    pw.connectOverCDP.mockResolvedValue({ close: pw.browserClose });
    const k = await kestrel.connect();
    await k.close();
    expect(calls()).toContain(`POST /v1/sessions/${SESSION_ID}/stop`);
  });

  it("stops the session when attaching fails", async () => {
    pw.connectOverCDP.mockRejectedValue(new Error("WebSocket error"));
    await expect(kestrel.connect()).rejects.toThrow("WebSocket error");
    expect(calls()).toEqual([
      "POST /v1/sessions",
      `POST /v1/sessions/${SESSION_ID}/stop`,
    ]);
  });

  it("stops the session when it has no connectUrl", async () => {
    api.on("POST", "/v1/sessions", {
      status: 200,
      body: fakeSession({ status: "stopping", connectUrl: null }),
    });
    await expect(kestrel.connect()).rejects.toThrow(/no connectUrl/);
    expect(pw.connectOverCDP).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(2);
  });
});
