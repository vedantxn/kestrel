import type { Session, SessionEvent } from "@kestrel/sdk";
import { describe, expect, it } from "vitest";
import { USAGE, main, table } from "./main.js";

const ID = "ses_01k6e4m9t8f2xq3w5y7z9a1b2c";
const TOKEN = "secret-token";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: ID,
    status: "ready",
    endReason: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    readyAt: "2026-10-03T10:00:01.200Z",
    endedAt: null,
    connectUrl: `wss://kestrel.test:443/v1/sessions/${ID}/cdp?token=${TOKEN}`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    options: {
      timeout: 900_000,
      idleTimeout: 300_000,
      stopOnDisconnect: false,
      viewport: { width: 1280, height: 720 },
      network: {},
      metadata: { run: "nightly" },
    },
    nodeId: "a",
    startPath: "hot",
    usage: { browserSeconds: 3 },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: URL;
  body: unknown;
  auth: string | null;
}
type Route = (call: Call) => { status: number; body: unknown };

/**
 * Run the CLI against a fake `fetch`: the SDK underneath is real, so the requests checked
 * here are exactly what would go over the wire.
 */
async function cli(argv: string[], route: Route, env = {}) {
  const calls: Call[] = [];
  let stdout = "";
  let stderr = "";
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const r = route(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const code = await main(argv, {
    env: {
      KESTREL_API_KEY: "ksl_test",
      KESTREL_URL: "http://api.test",
      ...env,
    },
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    fetch,
  });
  return { code, stdout, stderr, calls };
}

const ok = (body: unknown) => () => ({ status: 200, body });

describe("sessions", () => {
  it("create sends the options and prints the session without its token", async () => {
    const r = await cli(
      [
        "sessions",
        "create",
        "--timeout",
        "60000",
        "--viewport",
        "800x600",
        "--allow",
        "example.com",
        "--allow",
        "*.example.org",
      ],
      () => ({ status: 201, body: session() }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe("POST");
    expect(r.calls[0]!.url.href).toBe("http://api.test/v1/sessions");
    expect(r.calls[0]!.auth).toBe("Bearer ksl_test");
    expect(r.calls[0]!.body).toMatchObject({
      timeout: 60_000,
      viewport: { width: 800, height: 600 },
      network: { allow: ["example.com", "*.example.org"] },
    });
    expect(r.stdout).toMatch(new RegExp(`^id\\s+${ID}$`, "m"));
    expect(r.stdout).toMatch(/^metadata\s+run=nightly$/m);
    expect(r.stdout).toContain(`kestrel connect-url ${ID}`);
    expect(r.stdout).not.toContain(TOKEN);
  });

  it("create --json prints the API's JSON", async () => {
    const r = await cli(["sessions", "create", "--json"], () => ({
      status: 201,
      body: session(),
    }));
    expect(JSON.parse(r.stdout)).toEqual(session());
  });

  it("list prints a table and the next cursor", async () => {
    const r = await cli(
      ["sessions", "list", "--status", "stopped", "--limit", "2"],
      ok({
        data: [
          session({ status: "stopped", endReason: "client_stop" }),
          session({
            id: "ses_2",
            status: "stopped",
            endReason: "idle_timeout",
          }),
        ],
        nextCursor: "next",
      }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url.search).toBe("?status=stopped&limit=2");
    expect(r.stdout).toBe(
      [
        "ID                              STATUS   CREATED                   END REASON",
        `${ID}  stopped  2026-10-03T10:00:00.000Z  client_stop`,
        "ses_2                           stopped  2026-10-03T10:00:00.000Z  idle_timeout",
        "",
        "More: kestrel sessions list --cursor next",
        "",
      ].join("\n"),
    );
  });

  it("get and stop take an id", async () => {
    const got = await cli(["sessions", "get", ID], ok(session()));
    expect(got.calls[0]!.url.pathname).toBe(`/v1/sessions/${ID}`);
    expect(got.stdout).toMatch(/^status\s+ready$/m);
    expect(got.stdout).not.toContain(TOKEN);

    const stopped = await cli(
      ["sessions", "stop", ID],
      ok(session({ status: "stopping", connectUrl: null })),
    );
    expect(stopped.calls[0]!.method).toBe("POST");
    expect(stopped.calls[0]!.url.pathname).toBe(`/v1/sessions/${ID}/stop`);
    expect(stopped.stdout).toBe(`${ID} stopping\n`);
  });

  it("--api-key and --url override the environment", async () => {
    const r = await cli(
      [
        "sessions",
        "get",
        ID,
        "--api-key",
        "ksl_flag",
        "--url",
        "http://other.test",
      ],
      ok(session()),
    );
    expect(r.calls[0]!.auth).toBe("Bearer ksl_flag");
    expect(r.calls[0]!.url.host).toBe("other.test");
  });
});

describe("connect-url", () => {
  it("prints only the URL", async () => {
    const r = await cli(["connect-url", ID], ok(session()));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${session().connectUrl}\n`);
  });

  it("fails when the session cannot be connected to", async () => {
    const r = await cli(
      ["connect-url", ID],
      ok(session({ status: "stopped", connectUrl: null })),
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("is stopped");
  });
});

describe("logs", () => {
  const ev = (n: number, body: Pick<SessionEvent, "type" | "data">) =>
    ({
      id: `evt_${n}`,
      sessionId: ID,
      at: `2026-10-03T10:00:0${n}.000Z`,
      ...body,
    }) as SessionEvent;
  const e1 = ev(1, { type: "session.requested", data: {} });
  const e2 = ev(2, {
    type: "egress.denied",
    data: { host: "evil.test", port: 443, reason: "in_deny_list", count: 2 },
  });
  const e3 = ev(3, {
    type: "session.ended",
    data: { endReason: "client_stop", status: "stopped" },
  });

  it("prints one line per event", async () => {
    const r = await cli(["logs", ID], ok({ data: [e1, e2], nextCursor: null }));
    expect(r.stdout).toBe(
      "2026-10-03T10:00:01.000Z  session.requested\n" +
        "2026-10-03T10:00:02.000Z  egress.denied       host=evil.test port=443 reason=in_deny_list count=2\n",
    );
  });

  it("--follow --json prints JSON lines until the session ends", async () => {
    const pages = [[e1], [e1, e2], [e1, e2, e3]];
    let n = 0;
    const r = await cli(["logs", ID, "--follow", "--json"], () => ({
      status: 200,
      body: { data: pages[Math.min(n++, 2)], nextCursor: null },
    }));
    expect(r.code).toBe(0);
    expect(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(r.calls).toHaveLength(3);
  }, 10_000);
});

describe("errors", () => {
  it("prints the API's code and request id and exits 1", async () => {
    const r = await cli(["sessions", "get", ID], () => ({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: "No such session.",
          retryable: false,
          requestId: "req-42",
        },
      },
    }));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: 404 not_found: No such session. (request req-42)\n",
    );
  });

  it("exits 1 without an API key", async () => {
    const r = await cli(["sessions", "list"], ok({}), {
      KESTREL_API_KEY: undefined,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("KESTREL_API_KEY");
    expect(r.calls).toHaveLength(0);
  });

  it.each([
    [["sessions", "frobnicate"], "unknown command: sessions frobnicate"],
    [["sessions", "get"], "sessions get takes <id>"],
    [["sessions", "list", "extra"], "sessions list takes no arguments"],
    [
      ["sessions", "create", "--timeout", "soon"],
      "--timeout must be a whole number",
    ],
    [["sessions", "create", "--viewport", "big"], "--viewport must look like"],
    [["sessions", "get", ID, "--follow"], "Unknown option '--follow'"],
  ])("exits 2 on bad usage: %j", async (argv, message) => {
    const r = await cli(argv, ok({}));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain("Usage: kestrel");
    expect(r.calls).toHaveLength(0);
  });

  it("prints usage for --help", async () => {
    const r = await cli(["--help"], ok({}));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });
});

describe("table", () => {
  it("pads every column but the last", () => {
    expect(
      table([
        ["a", "bb"],
        ["ccc", "d"],
      ]),
    ).toBe("a    bb\nccc  d\n");
  });
});
