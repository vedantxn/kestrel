import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile, Session, SessionEvent } from "@kestrel/sdk";
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
      captcha: { solve: false },
    },
    nodeId: "a",
    startPath: "hot",
    usage: { browserSeconds: 3, egressBytesUp: 0, egressBytesDown: 0 },
    captcha: null,
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

  it("create asks a provider for an exit and a time zone, and shows them with the bytes", async () => {
    const proxied = session({
      options: {
        ...session().options,
        proxy: {
          server: "socks5://gate.decodo.com:7000",
          username: "acme",
          provider: "decodo",
          country: "DE",
          city: "munich",
          sticky: "abc123",
          stickyMinutes: 30,
        },
        timezone: "Europe/Berlin",
      },
      usage: { browserSeconds: 3, egressBytesUp: 120, egressBytesDown: 4567 },
    });
    const r = await cli(
      [
        "sessions",
        "create",
        "--proxy",
        "socks5://gate.decodo.com:7000",
        "--proxy-username",
        "acme",
        "--proxy-provider",
        "decodo",
        "--proxy-country",
        "DE",
        "--proxy-city",
        "munich",
        "--proxy-sticky",
        "abc123",
        "--proxy-sticky-minutes",
        "30",
        "--timezone",
        "Europe/Berlin",
      ],
      () => ({ status: 201, body: proxied }),
      { KESTREL_PROXY_PASSWORD: "pr0xy-cli" },
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toMatchObject({
      proxy: {
        server: "socks5://gate.decodo.com:7000",
        username: "acme",
        password: "pr0xy-cli",
        provider: "decodo",
        country: "DE",
        city: "munich",
        sticky: "abc123",
        stickyMinutes: 30,
      },
      timezone: "Europe/Berlin",
    });
    expect(r.stdout).toMatch(
      /^proxy\s+socks5:\/\/gate\.decodo\.com:7000 \(as acme\); exit DE, munich, sticky abc123 for 30 min via decodo$/m,
    );
    expect(r.stdout).toMatch(/^timezone\s+Europe\/Berlin$/m);
    expect(r.stdout).toMatch(/^egress bytes\s+120 up, 4567 down$/m);
    expect(r.stdout + r.stderr).not.toContain("pr0xy-cli");
  });

  it("create refuses exit flags without --proxy", async () => {
    const r = await cli(
      ["sessions", "create", "--proxy-country", "DE"],
      ok(session()),
    );
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
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

  it("get shows a CAPTCHA that is showing", async () => {
    const r = await cli(["sessions", "get", ID], () => ({
      status: 200,
      body: session({
        captcha: {
          providers: ["recaptcha", "turnstile"],
          since: "2026-10-05T10:00:00.000Z",
          solve: null,
        },
      }),
    }));
    expect(r.stdout).toMatch(
      /^captcha\s+recaptcha, turnstile \(since 2026-10-05T10:00:00.000Z\)$/m,
    );
    const failed = await cli(["sessions", "get", ID], () => ({
      status: 200,
      body: session({
        captcha: {
          providers: ["geetest"],
          since: "2026-10-05T10:00:00.000Z",
          solve: {
            provider: "geetest",
            status: "failed",
            at: "2026-10-05T10:00:01.000Z",
            reason: "unsupported",
          },
        },
      }),
    }));
    expect(failed.stdout).toMatch(
      /^captcha\s+geetest \(since 2026-10-05T10:00:00.000Z\); geetest failed \(unsupported\)$/m,
    );
    const none = await cli(["sessions", "get", ID], () => ({
      status: 200,
      body: session(),
    }));
    expect(none.stdout).toMatch(/^captcha\s+-$/m);
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

  it("create --solve-captchas asks for solving; without it, nothing is sent", async () => {
    const r = await cli(["sessions", "create", "--solve-captchas"], () => ({
      status: 201,
      body: session({
        options: { ...session().options, captcha: { solve: true } },
      }),
    }));
    expect(r.calls[0]!.body).toMatchObject({ captcha: { solve: true } });
    expect(r.stdout).toMatch(/^solve captchas\s+yes$/m);
    const plain = await cli(["sessions", "create"], () => ({
      status: 201,
      body: session(),
    }));
    expect(plain.calls[0]!.body).not.toHaveProperty("captcha");
    expect(plain.stdout).toMatch(/^solve captchas\s+no$/m);
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

const PRF = "prf_01k6e4m9t8f2xq3w5y7z9a1b2c";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PRF,
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
const busy = () => ({
  status: 409,
  body: {
    error: {
      code: "conflict",
      message:
        "Another session is saving into this profile; only one may at a time.",
      retryable: true,
      requestId: "req-7",
      param: "profile.id",
    },
  },
});

describe("profiles", () => {
  it("create sends the name and metadata and prints the profile", async () => {
    const r = await cli(
      [
        "profiles",
        "create",
        "--name",
        "work",
        "--metadata",
        "team=a",
        "--metadata",
        "url=https://x.test/?a=b",
      ],
      () => ({
        status: 201,
        body: profile({ metadata: { team: "a", url: "https://x.test/?a=b" } }),
      }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe("POST");
    expect(r.calls[0]!.url.pathname).toBe("/v1/profiles");
    expect(r.calls[0]!.body).toEqual({
      name: "work",
      metadata: { team: "a", url: "https://x.test/?a=b" },
    });
    expect(r.stdout).toMatch(new RegExp(`^id\\s+${PRF}$`, "m"));
    expect(r.stdout).toMatch(/^version\s+0 \(nothing saved yet\)$/m);
    expect(r.stdout).toMatch(
      /^metadata\s+team=a url=https:\/\/x.test\/\?a=b$/m,
    );
    expect(r.stdout).toContain(
      `kestrel sessions create --profile ${PRF} --persist`,
    );
  });

  it("create with no flags sends an empty body", async () => {
    const r = await cli(["profiles", "create", "--json"], () => ({
      status: 201,
      body: profile({ name: null }),
    }));
    expect(r.calls[0]!.body).toEqual({});
    expect(JSON.parse(r.stdout)).toEqual(profile({ name: null }));
  });

  it("list prints a table and the next cursor", async () => {
    const r = await cli(
      ["profiles", "list", "--limit", "2", "--cursor", "c1"],
      ok({
        data: [
          profile({
            version: 3,
            bytes: 4096,
            savedAt: "2026-10-07T11:00:00.000Z",
            inUseBy: ID,
          }),
          profile({ id: "prf_2", name: null }),
        ],
        nextCursor: "next",
      }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url.pathname).toBe("/v1/profiles");
    expect(r.calls[0]!.url.search).toBe("?limit=2&cursor=c1");
    expect(r.stdout).toBe(
      [
        "ID                              NAME  VERSION  BYTES  SAVED                     IN USE BY",
        `${PRF}  work  3        4096   2026-10-07T11:00:00.000Z  ${ID}`,
        "prf_2                                 0        0",
        "",
        "More: kestrel profiles list --cursor next",
        "",
      ].join("\n"),
    );
  });

  it("get and delete take an id", async () => {
    const got = await cli(
      ["profiles", "get", PRF],
      ok(profile({ version: 2, chromeMajor: 154, savedBySessionId: ID })),
    );
    expect(got.calls[0]!.url.pathname).toBe(`/v1/profiles/${PRF}`);
    expect(got.stdout).toMatch(/^version\s+2$/m);
    expect(got.stdout).toMatch(/^chrome\s+154$/m);
    expect(got.stdout).toMatch(new RegExp(`^saved by\\s+${ID}$`, "m"));

    const deleted = await cli(["profiles", "delete", PRF], () => ({
      status: 204,
      body: undefined,
    }));
    expect(deleted.code).toBe(0);
    expect(deleted.calls[0]!.method).toBe("DELETE");
    expect(deleted.calls[0]!.url.pathname).toBe(`/v1/profiles/${PRF}`);
    expect(deleted.stdout).toBe(`${PRF} deleted\n`);
  });

  it("sessions create --profile --persist starts from a profile and saves into it", async () => {
    const withProfile = session({
      startPath: "warm",
      options: { ...session().options, profile: { id: PRF, persist: true } },
    });
    const r = await cli(
      ["sessions", "create", "--profile", PRF, "--persist"],
      () => ({ status: 201, body: withProfile }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toMatchObject({
      profile: { id: PRF, persist: true },
    });
    expect(r.stdout).toMatch(
      new RegExp(`^profile\\s+${PRF} \\(saves at a clean end\\)$`, "m"),
    );
    expect(r.stdout).toMatch(/^start path\s+warm$/m);

    const reader = await cli(["sessions", "create", "--profile", PRF], () => ({
      status: 201,
      body: session(),
    }));
    expect(reader.calls[0]!.body).toMatchObject({ profile: { id: PRF } });
    expect(
      (reader.calls[0]!.body as { profile: object }).profile,
    ).not.toHaveProperty("persist");
    expect(reader.stdout).toMatch(/^profile\s+-$/m);
  });

  it("a busy profile fails at once, or is waited for with --wait-for-profile", async () => {
    const r = await cli(
      ["sessions", "create", "--profile", PRF, "--persist"],
      busy,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("409 conflict: Another session is saving");
    expect(r.calls).toHaveLength(1);

    let n = 0;
    const waited = await cli(
      [
        "sessions",
        "create",
        "--profile",
        PRF,
        "--persist",
        "--wait-for-profile",
        "30000",
      ],
      () => (++n < 3 ? busy() : { status: 201, body: session() }),
    );
    expect(waited.code).toBe(0);
    expect(waited.calls).toHaveLength(3);
  });

  it("refuses --persist and --wait-for-profile without --profile, and bad metadata", async () => {
    for (const [argv, message] of [
      [["sessions", "create", "--persist"], "--persist needs --profile"],
      [
        ["sessions", "create", "--wait-for-profile", "1000"],
        "--wait-for-profile needs --profile",
      ],
      [
        ["profiles", "create", "--metadata", "team"],
        "--metadata must look like key=value",
      ],
      [["profiles", "get"], "profiles get takes <id>"],
      [["profiles", "frobnicate"], "unknown command: profiles frobnicate"],
    ] as const) {
      const r = await cli([...argv], ok({}));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.calls).toHaveLength(0);
    }
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
