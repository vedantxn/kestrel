import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent } from "@kestrel/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      recording: false,
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
    if (Buffer.isBuffer(r.body))
      return new Response(new Uint8Array(r.body), {
        status: r.status,
        headers: { "content-type": "video/mp4" },
      });
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

  it("create --proxy takes the password from the environment only, and never prints it", async () => {
    const proxied = session({
      options: {
        ...session().options,
        proxy: { server: "http://proxy.example.com:3128", username: "u" },
      },
    });
    const r = await cli(
      [
        "sessions",
        "create",
        "--proxy",
        "http://proxy.example.com:3128",
        "--proxy-username",
        "u",
      ],
      () => ({ status: 201, body: proxied }),
      { KESTREL_PROXY_PASSWORD: "pr0xy-cli" },
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toMatchObject({
      proxy: {
        server: "http://proxy.example.com:3128",
        username: "u",
        password: "pr0xy-cli",
      },
    });
    expect(r.stdout).toMatch(
      /^proxy\s+http:\/\/proxy\.example\.com:3128 \(as u\)$/m,
    );
    expect(r.stdout + r.stderr).not.toContain("pr0xy-cli");
  });

  it("create refuses a proxy password without a username, and a username without a proxy", async () => {
    const noUser = await cli(
      ["sessions", "create", "--proxy", "http://p.example.com:3128"],
      ok(session()),
      { KESTREL_PROXY_PASSWORD: "pr0xy-cli" },
    );
    expect(noUser.code).toBe(2);
    expect(noUser.calls).toHaveLength(0);
    expect(noUser.stderr).not.toContain("pr0xy-cli");
    const noProxy = await cli(
      ["sessions", "create", "--proxy-username", "u"],
      ok(session()),
    );
    expect(noProxy.code).toBe(2);
    expect(noProxy.calls).toHaveLength(0);
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

describe("recording, live view and screenshots", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-cli-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("create --record asks for a recording", async () => {
    const r = await cli(["sessions", "create", "--record"], () => ({
      status: 201,
      body: session({ options: { ...session().options, recording: true } }),
    }));
    expect(r.calls[0]!.body).toMatchObject({ recording: true });
    expect(r.stdout).toMatch(/^recording\s+yes$/m);
  });

  it("live prints a view URL, or a control URL with --control and --ttl", async () => {
    const viewer = `https://kestrel.test/live/${ID}#ws=x&token=t`;
    const minted = ok({
      scope: "view",
      token: "t",
      url: viewer,
      expiresAt: "2026-10-03T10:10:00.000Z",
    });
    const view = await cli(["live", ID], minted);
    expect(view.stdout).toBe(`${viewer}\n`);
    expect(view.calls[0]!.url.pathname).toBe(`/v1/sessions/${ID}/tokens`);
    expect(view.calls[0]!.body).toEqual({ scope: "view" });

    const control = await cli(
      ["live", ID, "--control", "--ttl", "60000"],
      minted,
    );
    expect(control.calls[0]!.body).toEqual({ scope: "control", ttlMs: 60_000 });
  });

  it("screenshot writes the PNG from /computer", async () => {
    const png = Buffer.from("\x89PNG\r\n\x1a\nfake");
    const out = join(dir, "shot.png");
    const r = await cli(
      ["screenshot", ID, "-o", out],
      ok({
        ok: true,
        screenshot: png.toString("base64"),
        width: 1280,
        height: 720,
        url: "https://example.com/",
      }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url.pathname).toBe(`/v1/sessions/${ID}/computer`);
    expect(r.calls[0]!.body).toEqual({ action: "screenshot" });
    expect((await readFile(out)).equals(png)).toBe(true);
    expect(r.stdout).toBe(`${out}  1280x720  https://example.com/\n`);
  });

  it("recording saves the video", async () => {
    const video = Buffer.from("\0\0\0\x18ftypisom-video");
    const out = join(dir, "s.mp4");
    const r = await cli(["recording", ID, "--output", out, "--json"], () => ({
      status: 200,
      body: video,
    }));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url.pathname).toBe(`/v1/sessions/${ID}/recording`);
    expect((await readFile(out)).equals(video)).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual({ path: out, bytes: video.length });
  });

  it("recording of an unrecorded session exits 1 and writes nothing", async () => {
    const out = join(dir, "s.mp4");
    const r = await cli(["recording", ID, "-o", out], () => ({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: "This session was not recorded.",
          retryable: false,
          requestId: "req-7",
        },
      },
    }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not recorded");
    expect(existsSync(out)).toBe(false);
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
