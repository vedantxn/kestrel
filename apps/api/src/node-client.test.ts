import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@kestrel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NodeConfig } from "./config.js";
import { HttpNodeClient, NodeCallError } from "./node-client.js";

const SECRET = "node-a-secret-0123456789";
let server: Server;
let client: HttpNodeClient;
let mode = "ready";
const seen: { path: string; auth: string | undefined; body: unknown }[] = [];

const ses = newId("ses");
const prj = newId("prj");
const startReq = {
  sessionId: ses as never,
  projectId: prj as never,
  epoch: 1,
  viewport: { width: 1280, height: 720 },
  network: {},
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  stopOnDisconnect: false,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (mode === "slow") return; // never answers
      if (mode === "garbage") return res.end('{"result":"maybe"}');
      if (mode === "html") return res.end("<html>");
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/stop") return res.end('{"result":"gone"}');
      return res.end(
        mode === "refuse"
          ? '{"result":"refused","reason":"full"}'
          : '{"result":"ready","startPath":"hot","readyMs":9,"deviceScaleFactor":1}',
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const nodes = new Map<string, NodeConfig>([
    [
      "a",
      {
        id: "a",
        address: `http://127.0.0.1:${port}`,
        secret: SECRET,
        connectPort: 8443,
      },
    ],
    [
      "bad",
      {
        id: "bad",
        address: `http://127.0.0.1:${port}`,
        secret: "wrong-secret-0123456789",
        connectPort: 8443,
      },
    ],
    [
      "dead",
      {
        id: "dead",
        address: "http://127.0.0.1:1",
        secret: SECRET,
        connectPort: 8443,
      },
    ],
  ]);
  client = new HttpNodeClient(nodes);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("HttpNodeClient", () => {
  it("posts the request with the node's bearer secret and parses the answer", async () => {
    mode = "ready";
    const res = await client.start("a", startReq, 1000);
    expect(res).toEqual({
      result: "ready",
      startPath: "hot",
      readyMs: 9,
      deviceScaleFactor: 1,
    });
    const call = seen.at(-1)!;
    expect(call).toMatchObject({ path: "/v1/start", auth: `Bearer ${SECRET}` });
    expect(call.body).toMatchObject({
      sessionId: ses,
      epoch: 1,
      viewport: { width: 1280, height: 720 },
    });
  });

  it("parses a refusal and a stop answer", async () => {
    mode = "refuse";
    expect(await client.start("a", startReq, 1000)).toEqual({
      result: "refused",
      reason: "full",
    });
    mode = "ready";
    expect(
      await client.stop(
        "a",
        { sessionId: ses as never, reason: "client_stop" },
        1000,
      ),
    ).toEqual({ result: "gone" });
  });

  it("reports a bad secret, a malformed answer and a non-JSON answer as bad_response", async () => {
    mode = "ready";
    await expect(client.start("bad", startReq, 1000)).rejects.toMatchObject({
      kind: "bad_response",
    });
    mode = "garbage";
    await expect(client.start("a", startReq, 1000)).rejects.toMatchObject({
      kind: "bad_response",
    });
    mode = "html";
    await expect(client.start("a", startReq, 1000)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("times out on a node that never answers", async () => {
    mode = "slow";
    const t = Date.now();
    await expect(client.start("a", startReq, 150)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("reports an unreachable node, and an unknown one", async () => {
    await expect(client.start("dead", startReq, 500)).rejects.toMatchObject({
      kind: "unreachable",
    });
    await expect(client.start("nope", startReq, 500)).rejects.toBeInstanceOf(
      NodeCallError,
    );
  });
});
