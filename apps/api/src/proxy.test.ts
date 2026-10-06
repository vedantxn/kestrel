import { Writable } from "node:stream";
import {
  ErrorResponse,
  ListEventsResponse,
  NetworkPolicy,
  Session,
  type StartRequest,
} from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { requestHash } from "./idempotency.js";
import { NodeCallError } from "./node-client.js";
import { makeEnv, type Env } from "./test/harness.js";

const PASSWORD = "pr0xy-pa55-api";
const proxy = {
  server: "HTTP://Proxy.Example.com:3128/",
  username: "user-1",
  password: PASSWORD,
};

let env: Env;
let lines: string[] = [];
const reset = async () => {
  await env?.close();
  lines = [];
  env = await makeEnv({
    log: createLogger(
      "test",
      "debug",
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    ),
  });
};
beforeEach(() => reset());
afterAll(async () => env?.close());

const error = (res: { json(): unknown }) =>
  ErrorResponse.parse(res.json()).error;

describe("a session's upstream proxy through the API", () => {
  it("returns the proxy without its password, and sends the password only to the node", async () => {
    const res = await env.create({ proxy });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PASSWORD);
    const s = Session.parse(res.json());
    expect(s.options.proxy).toEqual({
      server: "http://proxy.example.com:3128",
      username: "user-1",
    });
    const start = env.nodes.a!.startCalls[0]!;
    expect(start.network).toEqual({
      upstream: {
        host: "proxy.example.com",
        port: 3128,
        username: "user-1",
        password: PASSWORD,
      },
    });
    for (const url of [`/v1/sessions/${s.id}`, "/v1/sessions"]) {
      const r = await env.call("GET", url);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("proxy.example.com");
      expect(r.body).not.toContain(PASSWORD);
    }
  });

  it("keeps the allow and deny lists beside the proxy", async () => {
    await env.create({ proxy, network: { allow: ["example.com"] } });
    expect(env.nodes.a!.startCalls[0]!.network).toMatchObject({
      allow: ["example.com"],
      upstream: { host: "proxy.example.com" },
    });
  });

  it("stores neither the password nor anything made from it", async () => {
    await env.create({ proxy, idempotencyKey: "k1" });
    const rows = await env.db.$queryRawUnsafe<{ t: string }[]>(
      `SELECT options::text AS t FROM sessions
       UNION ALL SELECT row_to_json(i)::text FROM idempotency_keys i
       UNION ALL SELECT data::text FROM session_events`,
    );
    const all = rows.map((r) => r.t).join("\n");
    expect(all).toContain("proxy.example.com");
    expect(all).not.toContain(PASSWORD);
    const key = await env.db.idempotencyKey.findFirst();
    const session = await env.db.session.findFirst();
    expect(key!.requestHash).toBe(requestHash(session!.options));
  });

  it("answers a repeat with the same key whatever the password, and refuses a different proxy", async () => {
    const first = Session.parse(
      (await env.create({ proxy, idempotencyKey: "k2" })).json(),
    );
    const again = await env.create({
      proxy: { ...proxy, password: "another" },
      idempotencyKey: "k2",
    });
    expect(again.statusCode).toBe(200);
    expect(Session.parse(again.json()).id).toBe(first.id);
    const other = await env.create({
      proxy: { ...proxy, server: "http://proxy.example.com:8080" },
      idempotencyKey: "k2",
    });
    expect(other.statusCode).toBe(409);
    expect(env.nodes.a!.startCalls).toHaveLength(1);
  });

  it.each([
    [{ server: "socks4://p.example.com:1080" }, "proxy.server"],
    [{ server: "http://p.example.com:25" }, "proxy.server"],
    [{ server: "http://10.0.0.1" }, "proxy.server"],
    [
      { server: "http://p.example.com:3128", password: PASSWORD },
      "proxy.password",
    ],
    [
      {
        server: "http://p.example.com:3128",
        username: "a:b",
        password: PASSWORD,
      },
      "proxy.username",
    ],
    [{ server: "http://p.example.com:3128", bypass: "x" }, "proxy.bypass"],
  ])(
    "refuses %j, naming %s and never echoing the value",
    async (bad, param) => {
      const res = await env.create({ proxy: bad });
      expect(res.statusCode).toBe(400);
      expect(error(res)).toMatchObject({ code: "invalid_request", param });
      expect(res.body).not.toContain(PASSWORD);
      expect(env.nodes.a!.startCalls).toHaveLength(0);
    },
  );

  it("fails the create, rather than start without the proxy, on a node from before proxies (T-47)", async () => {
    const node = env.nodes.a!;
    const start = node.start.bind(node);
    // That node parsed `network` as the strict NetworkPolicy and answered 400.
    node.start = async (req: StartRequest) => {
      if (!NetworkPolicy.safeParse(req.network).success)
        throw new NodeCallError("node a: bad response (400)", "bad_response");
      return start(req);
    };
    const res = await env.create({ proxy });
    expect(res.statusCode).toBe(500);
    expect(error(res)).toMatchObject({ retryable: true });
    const [row] = await env.db.session.findMany();
    expect(row?.endReason).toBe("node_refused");
    // Sessions without a proxy still start there.
    expect((await env.create()).statusCode).toBe(201);
  });

  it("puts the proxy's failures on the session's timeline", async () => {
    const s = Session.parse((await env.create({ proxy })).json());
    env.nodes.a!.report(s.id, {
      type: "egress.denied",
      data: {
        host: "example.com",
        port: 443,
        reason: "upstream_auth_failed",
        count: 1,
      },
    });
    await env.nodes.a!.flushReports(env.internal);
    const events = ListEventsResponse.parse(
      (await env.call("GET", `/v1/sessions/${s.id}/events`)).json(),
    ).data;
    expect(events.find((e) => e.type === "egress.denied")?.data).toMatchObject({
      reason: "upstream_auth_failed",
    });
  });

  it("never logs the password", async () => {
    await env.create({ proxy });
    await env.create({ proxy: { ...proxy, username: "a:b" } });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(PASSWORD);
  });
});
