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

describe("SOCKS5, TLS, provider adapters and time zones through the API", () => {
  it("sends the adapted credentials and the scheme to the node, and stores what was asked", async () => {
    const res = await env.create({
      proxy: {
        server: "socks5://gate.decodo.com:7000",
        username: "acme",
        password: PASSWORD,
        provider: "decodo",
        country: "DE",
        city: "Munich",
        sticky: "abc123",
        stickyMinutes: 30,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PASSWORD);
    const s = Session.parse(res.json());
    expect(s.options.proxy).toEqual({
      server: "socks5://gate.decodo.com:7000",
      username: "acme",
      provider: "decodo",
      country: "DE",
      city: "Munich",
      sticky: "abc123",
      stickyMinutes: 30,
    });
    // Germany has one zone: it becomes the session's.
    expect(s.options.timezone).toBe("Europe/Berlin");
    const start = env.nodes.a!.startCalls[0]!;
    expect(start.timezone).toBe("Europe/Berlin");
    expect(start.network.upstream).toEqual({
      scheme: "socks5",
      host: "gate.decodo.com",
      port: 7000,
      username:
        "user-acme-country-de-city-munich-session-abc123-sessionduration-30",
      password: PASSWORD,
    });
    const [row] = await env.db.session.findMany();
    expect(JSON.stringify(row?.options)).not.toContain(PASSWORD);
  });

  it("keeps an explicit time zone, and sets none for a country with several", async () => {
    const tls = { server: "https://proxy.example.com:443" };
    const a = Session.parse(
      (
        await env.create({
          proxy: { ...tls, country: "DE" },
          timezone: "America/Chicago",
        })
      ).json(),
    );
    expect(a.options.timezone).toBe("America/Chicago");
    const b = Session.parse(
      (await env.create({ proxy: { ...tls, country: "US" } })).json(),
    );
    expect(b.options.timezone).toBeUndefined();
    expect(env.nodes.a!.startCalls[1]).not.toHaveProperty("timezone");
    // Without a proxy, a time zone can still be asked for.
    const c = Session.parse(
      (await env.create({ timezone: "Asia/Tokyo" })).json(),
    );
    expect(c.options.timezone).toBe("Asia/Tokyo");
  });

  it.each([
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [
      { proxy: { server: "socks5://s.example.com:1080", username: "u" } },
      "proxy.password",
    ],
    [
      { proxy: { server: "http://p.example.com:8080", country: "XX" } },
      "proxy.country",
    ],
    [
      {
        proxy: {
          server: "http://p.example.com:8080",
          username: "u",
          country: "US",
          city: "Austin",
        },
      },
      "proxy.city",
    ],
  ])("refuses %j, naming %s", async (body, field) => {
    const res = await env.create(body);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(error(res))).toContain(field);
    expect(env.nodes.a!.startCalls).toHaveLength(0);
  });

  it("refuses the start on a node from before time zones (T-47's rule: fail, never ignore)", async () => {
    const node = env.nodes.a!;
    const start = node.start.bind(node);
    node.start = async (req: StartRequest) => {
      if ("timezone" in req)
        throw new NodeCallError("node a: bad response (400)", "bad_response");
      return start(req);
    };
    const res = await env.create({ timezone: "Asia/Tokyo" });
    expect(res.statusCode).toBe(500);
    const [row] = await env.db.session.findMany();
    expect(row?.endReason).toBe("node_refused");
  });
});

describe("egress bytes per session (G-20)", () => {
  it("are recorded from the node's removed report and shown in the session's usage", async () => {
    const s = Session.parse((await env.create()).json());
    expect(s.usage).toEqual({
      browserSeconds: 0,
      egressBytesUp: 0,
      egressBytesDown: 0,
    });
    env.nodes.a!.teardown(s.id, "max_lifetime", 12, {
      up: 34_567,
      down: 9_876_543_210,
    });
    await env.nodes.a!.flushReports(env.internal);
    const got = Session.parse(
      (await env.call("GET", `/v1/sessions/${s.id}`)).json(),
    );
    expect(got.status).toBe("timed_out");
    expect(got.usage).toEqual({
      browserSeconds: 12,
      egressBytesUp: 34_567,
      egressBytesDown: 9_876_543_210,
    });
  });

  it("are zero from a node from before byte counters", async () => {
    const s = Session.parse((await env.create()).json());
    env.nodes.a!.teardown(s.id, "max_lifetime", 3);
    await env.nodes.a!.flushReports(env.internal);
    const got = Session.parse(
      (await env.call("GET", `/v1/sessions/${s.id}`)).json(),
    );
    expect(got.usage).toMatchObject({ egressBytesUp: 0, egressBytesDown: 0 });
  });
});
