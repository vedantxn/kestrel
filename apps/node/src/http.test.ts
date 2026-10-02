import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@kestrel/shared";
import { createNodeServer } from "./http.js";
import { bootWithPool, makeRig, startReq } from "./test/fakes.js";

const SECRET = "node-a-secret-0123456789";
let close: (() => void) | undefined;
afterEach(() => close?.());

async function rig() {
  const r = makeRig({ poolTarget: 0 });
  await bootWithPool(r);
  const server = createNodeServer(r.agent, SECRET, createLogger("t", "silent"));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  const port = (server.address() as AddressInfo).port;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    auth: string | null = `Bearer ${SECRET}`,
  ) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  return { r, call };
}

describe("the agent's HTTP server (C4)", () => {
  it("refuses a missing or wrong secret", async () => {
    const { call } = await rig();
    expect((await call("GET", "/v1/describe", undefined, null)).status).toBe(
      401,
    );
    expect(
      (await call("GET", "/v1/describe", undefined, "Bearer wrong")).status,
    ).toBe(401);
    expect(
      (await call("POST", "/v1/start", startReq(), "Bearer ")).status,
    ).toBe(401);
  });

  it("starts, describes and stops a session", async () => {
    const { r, call } = await rig();
    const req = startReq();
    const started = await call("POST", "/v1/start", req);
    expect(started).toMatchObject({
      status: 200,
      json: { result: "ready", startPath: "cold" },
    });
    const d = await call("GET", "/v1/describe");
    expect(d.json.sessions).toEqual([
      { sessionId: req.sessionId, state: "ready" },
    ]);
    const stopped = await call("POST", "/v1/stop", {
      sessionId: req.sessionId,
      reason: "client_stop",
    });
    expect(stopped).toMatchObject({
      status: 200,
      json: { result: "accepted" },
    });
    await r.agent.idle();
    expect(
      (
        await call("POST", "/v1/stop", {
          sessionId: req.sessionId,
          reason: "client_stop",
        })
      ).json,
    ).toEqual({ result: "gone" });
  });

  it("validates requests and answers unknown paths", async () => {
    const { call } = await rig();
    expect(
      (await call("POST", "/v1/start", { sessionId: "nope" })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/stop", {
          sessionId: startReq().sessionId,
          reason: "bogus",
        })
      ).status,
    ).toBe(400);
    expect((await call("GET", "/v1/nothing")).status).toBe(404);
  });
});
