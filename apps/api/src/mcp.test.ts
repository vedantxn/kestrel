import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListProfilesResponse, Profile, Session } from "@kestrel/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPublicApp } from "./http.js";
import {
  MCP_LIMITS,
  MCP_TOOLS,
  openPageOverCdp,
  type OpenPage,
} from "./mcp.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
let app: FastifyInstance | undefined;
let base = "";
const clients: Client[] = [];

/** What the browser tools were handed, and what the fake page answers. */
const fake = {
  connectUrls: [] as string[],
  closed: 0,
  text: "hello from the page",
  fail: undefined as Error | undefined,
};

const fakeOpenPage: OpenPage = async (connectUrl) => {
  fake.connectUrls.push(connectUrl);
  if (fake.fail) throw fake.fail;
  let current = "about:blank";
  const page = {
    goto: async (url: string) => {
      current = url;
      return { status: () => 200 };
    },
    title: async () => "Fake title",
    url: () => current,
    evaluate: async (expr: string) => {
      const n = Number(/slice\(0, (\d+)\)/.exec(expr)?.[1]);
      return fake.text.slice(0, n);
    },
  };
  return {
    page: page as unknown as Page,
    close: async () => {
      fake.closed++;
    },
  };
};

async function start(
  opts: Parameters<typeof makeEnv>[0] = {},
  openPage: OpenPage = fakeOpenPage,
) {
  await stop();
  env = await makeEnv(opts);
  app = buildPublicApp(env.ctx, { mcp: { openPage } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function stop() {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await app?.close();
  app = undefined;
  await env?.close();
}

async function connect(key = env.key): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => (await client.callTool({ name, arguments: args })) as CallToolResult;

const text = (r: CallToolResult): string => {
  const c = r.content[0];
  if (c?.type !== "text") throw new Error(`expected text, got ${c?.type}`);
  return c.text;
};
const body = (r: CallToolResult): unknown => JSON.parse(text(r));
const errorOf = (r: CallToolResult) => {
  expect(r.isError).toBe(true);
  return (body(r) as { error: Record<string, unknown> }).error;
};
const session = (r: CallToolResult): Session => {
  expect(r.isError).toBeFalsy();
  return Session.parse(body(r));
};

beforeEach(async () => {
  Object.assign(fake, {
    connectUrls: [],
    closed: 0,
    text: "hello from the page",
    fail: undefined,
  });
  await start();
});
afterAll(stop);

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

describe("/mcp transport and auth", () => {
  it("needs the same API key as the REST API", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(initialize),
      });
    for (const headers of [
      {} as Record<string, string>,
      { authorization: `Bearer ksl_${"x".repeat(43)}` },
      { authorization: "Bearer not-a-key" },
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(401);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("unauthorized");
    }
    expect((await post({ authorization: `Bearer ${env.key}` })).status).toBe(
      200,
    );
    expect((await post({ "x-api-key": env.key })).status).toBe(200);
  });

  it("is stateless: no GET stream and no session to delete", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: { authorization: `Bearer ${env.key}` },
      });
      expect(res.status).toBe(405);
    }
  });
});

describe("tool list", () => {
  it("lists the implemented tools, each with a plain object schema", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual([...MCP_TOOLS]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      // Some MCP clients cannot follow references; the schemas must be self-contained.
      expect(JSON.stringify(t.inputSchema)).not.toContain("$ref");
    }
    const create = tools.find((t) => t.name === "create_session");
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["timeout", "idleTimeout", "viewport", "network"]),
    );
  });
});

describe("session tools", () => {
  it("create, get, list, events and stop, in-process", async () => {
    const c = await connect();
    const created = session(
      await call(c, "create_session", {
        viewport: { width: 1024, height: 768 },
        metadata: { from: "mcp" },
      }),
    );
    expect(created.status).toBe("ready");
    expect(created.connectUrl).toMatch(/^wss:\/\/.+\?token=/);
    expect(created.viewport).toEqual({ width: 1024, height: 768 });
    expect(created.options.metadata).toEqual({ from: "mcp" });

    const got = session(
      await call(c, "get_session", { sessionId: created.id }),
    );
    expect(got.id).toBe(created.id);

    const list = body(await call(c, "list_sessions", { limit: 5 })) as {
      data: Session[];
    };
    expect(list.data.map((s) => s.id)).toContain(created.id);

    const events = body(
      await call(c, "session_events", { sessionId: created.id }),
    ) as { data: { type: string }[] };
    expect(events.data.map((e) => e.type)).toContain("session.ready");

    const stopped = session(
      await call(c, "stop_session", { sessionId: created.id }),
    );
    expect(["stopping", "stopped"]).toContain(stopped.status);
    expect(stopped.connectUrl).toBeNull();
    // Repeating a stop is harmless.
    session(await call(c, "stop_session", { sessionId: created.id }));
  });

  it("create_session takes a proxy, and its result never holds the password", async () => {
    const result = await call(await connect(), "create_session", {
      proxy: {
        server: "http://proxy.example.com:3128",
        username: "u",
        password: "pr0xy-mcp",
      },
    });
    expect(JSON.stringify(result)).not.toContain("pr0xy-mcp");
    const created = session(result);
    expect(created.options.proxy).toEqual({
      server: "http://proxy.example.com:3128",
      username: "u",
    });
    expect(env.nodes.a!.startCalls.at(-1)!.network.upstream?.password).toBe(
      "pr0xy-mcp",
    );
  });

  it("get_session shows a CAPTCHA a node reported", async () => {
    const c = await connect();
    const created = session(await call(c, "create_session"));
    const node = env.nodes[created.nodeId as string]!;
    node.report(created.id, {
      type: "captcha.detected",
      data: {
        provider: "turnstile",
        host: "a.example",
        present: ["turnstile"],
      },
    });
    await node.flushReports(env.internal);
    const got = session(
      await call(c, "get_session", { sessionId: created.id }),
    );
    expect(got.captcha?.providers).toEqual(["turnstile"]);
    expect(got.captcha?.solve).toBeNull();
  });

  it("create_session takes captcha.solve, refused with a reason when the deployment has no solver", async () => {
    const c = await connect();
    expect(
      errorOf(await call(c, "create_session", { captcha: { solve: true } })),
    ).toMatchObject({ code: "invalid_request" });
    const created = session(
      await call(c, "create_session", { captcha: { solve: false } }),
    );
    expect(created.options.captcha).toEqual({ solve: false });
  });

  it("is scoped to the key's project", async () => {
    const mine = session(await call(await connect(), "create_session"));
    const other = await connect(env.project2.key);
    expect(
      errorOf(await call(other, "get_session", { sessionId: mine.id })),
    ).toMatchObject({ code: "not_found", retryable: false });
    expect(
      errorOf(await call(other, "stop_session", { sessionId: mine.id })).code,
    ).toBe("not_found");
    const list = body(await call(other, "list_sessions")) as {
      data: unknown[];
    };
    expect(list.data).toEqual([]);
  });

  it("validates input against the REST contract", async () => {
    const c = await connect();
    // Caught by the tool's own schema.
    const r1 = await call(c, "create_session", {
      viewport: { width: 10, height: 10 },
    });
    expect(r1.isError).toBe(true);
    // Caught by the contract, which the tool schema does not repeat.
    expect(
      errorOf(
        await call(c, "create_session", { network: { allow: ["http://x/"] } }),
      ),
    ).toMatchObject({ code: "invalid_request", param: "network.allow.0" });
    expect(
      errorOf(await call(c, "get_session", { sessionId: "nope" })).code,
    ).toBe("not_found");
  });

  it("applies the project's create rate limit", async () => {
    await start({ createsPerMinute: 1 });
    const c = await connect();
    session(await call(c, "create_session"));
    expect(errorOf(await call(c, "create_session"))).toMatchObject({
      code: "quota_exceeded",
      retryable: true,
    });
  });
});

describe("profile tools", () => {
  const profile = (r: CallToolResult): Profile => {
    expect(r.isError).toBeFalsy();
    return Profile.parse(body(r));
  };
  const profiles = (r: CallToolResult) => {
    expect(r.isError).toBeFalsy();
    return ListProfilesResponse.parse(body(r));
  };

  it("has create_profile and list_profiles, and no tool that deletes a profile", async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["create_profile", "list_profiles"]),
    );
    expect(names.filter((n) => /delete|remove/.test(n))).toEqual([]);
    const create = tools.find((t) => t.name === "create_session");
    expect(Object.keys(create?.inputSchema.properties ?? {})).toContain(
      "profile",
    );
  });

  it("log in once, reuse it: a writer saves, a later session starts from the saved version", async () => {
    await start({ profiles: true });
    const c = await connect();
    const p = profile(
      await call(c, "create_profile", {
        name: "work",
        metadata: { from: "mcp" },
      }),
    );
    expect(p).toMatchObject({
      name: "work",
      metadata: { from: "mcp" },
      version: 0,
      inUseBy: null,
    });

    const writer = session(
      await call(c, "create_session", { profile: { id: p.id, persist: true } }),
    );
    expect(writer.options.profile).toEqual({ id: p.id, persist: true });
    expect(
      profiles(await call(c, "list_profiles")).data.find((x) => x.id === p.id)
        ?.inUseBy,
    ).toBe(writer.id);

    // One writer at a time: a second is refused with a retryable conflict on profile.id.
    expect(
      errorOf(
        await call(c, "create_session", {
          profile: { id: p.id, persist: true },
        }),
      ),
    ).toMatchObject({
      code: "conflict",
      retryable: true,
      param: "profile.id",
    });

    session(await call(c, "stop_session", { sessionId: writer.id }));
    await env.syncAll();
    const saved = profiles(await call(c, "list_profiles", { limit: 1 }));
    expect(saved.data[0]).toMatchObject({
      id: p.id,
      version: 1,
      inUseBy: null,
      savedBySessionId: writer.id,
    });

    const reader = session(
      await call(c, "create_session", { profile: { id: p.id } }),
    );
    expect(reader.startPath).toBe("warm");
    expect(reader.options.profile).toEqual({ id: p.id, persist: false });
  });

  it("list_profiles pages with a cursor", async () => {
    await start({ profiles: true });
    const c = await connect();
    for (const name of ["a", "b", "c"])
      profile(await call(c, "create_profile", { name }));
    const first = profiles(await call(c, "list_profiles", { limit: 2 }));
    expect(first.data.map((x) => x.name)).toEqual(["c", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = profiles(
      await call(c, "list_profiles", { limit: 2, cursor: first.nextCursor }),
    );
    expect(second.data.map((x) => x.name)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("is scoped to the key's project, and validates against the REST contract", async () => {
    await start({ profiles: true });
    const mine = profile(await call(await connect(), "create_profile", {}));
    const other = await connect(env.project2.key);
    expect(profiles(await call(other, "list_profiles")).data).toEqual([]);
    expect(
      errorOf(
        await call(other, "create_session", { profile: { id: mine.id } }),
      ),
    ).toMatchObject({ code: "not_found", param: "profile.id" });
    // Caught by the contract: names are plain text.
    expect(
      errorOf(await call(other, "create_profile", { name: "a\u0000b" })),
    ).toMatchObject({ code: "invalid_request", param: "name" });
    // A second profile with the same name is a conflict that retrying will not fix.
    profile(await call(other, "create_profile", { name: "dup" }));
    expect(
      errorOf(await call(other, "create_profile", { name: "dup" })),
    ).toMatchObject({ code: "conflict", retryable: false, param: "name" });
  });

  it("answers invalid_request on a deployment without profiles", async () => {
    const c = await connect();
    expect(errorOf(await call(c, "create_profile", {}))).toMatchObject({
      code: "invalid_request",
    });
    expect(errorOf(await call(c, "list_profiles"))).toMatchObject({
      code: "invalid_request",
    });
    expect(
      errorOf(
        await call(c, "create_session", {
          profile: { id: "prf_01k6e4m9t8f2xq3w5y7z9a1b2c" },
        }),
      ),
    ).toMatchObject({ code: "invalid_request", param: "profile" });
  });
});

describe("CDP tools (fake page)", () => {
  it("navigate and get_page_text use the session's connectUrl", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));

    const nav = body(
      await call(c, "navigate", {
        sessionId: s.id,
        url: "https://example.com/",
      }),
    );
    expect(nav).toEqual({
      url: "https://example.com/",
      title: "Fake title",
      status: 200,
    });

    const page = body(await call(c, "get_page_text", { sessionId: s.id }));
    expect(page).toMatchObject({
      truncated: false,
      text: "hello from the page",
    });

    expect(fake.connectUrls).toEqual([s.connectUrl, s.connectUrl]);
    expect(fake.closed).toBe(2); // every call disconnects
  });

  it("bounds what comes back from the page", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));

    fake.text = "x".repeat(5_000);
    const page = body(
      await call(c, "get_page_text", { sessionId: s.id, maxChars: 1_000 }),
    ) as { truncated: boolean; text: string };
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(1_000);
  });

  it("refuses what it should not do", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "nope"]) {
      expect(
        errorOf(await call(c, "navigate", { sessionId: s.id, url })),
      ).toMatchObject({ code: "invalid_request", param: "url" });
    }

    // Each call connects and disconnects, which would end such a session.
    const sod = session(
      await call(c, "create_session", { stopOnDisconnect: true }),
    );
    expect(
      errorOf(await call(c, "get_page_text", { sessionId: sod.id })).code,
    ).toBe("invalid_request");

    await call(c, "stop_session", { sessionId: s.id });
    expect(
      errorOf(await call(c, "get_page_text", { sessionId: s.id })),
    ).toMatchObject({ code: "conflict" });
    expect(fake.connectUrls).toEqual([]);
  });

  it("never hands back the token from a connection error", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    fake.fail = new Error(`connect failed: ${s.connectUrl}\nstack line`);
    const e = errorOf(await call(c, "get_page_text", { sessionId: s.id }));
    expect(e).toMatchObject({ code: "internal", retryable: true });
    const token = new URL(s.connectUrl as string).searchParams.get("token");
    expect(JSON.stringify(e)).not.toContain(token);
    expect(String(e.message)).toContain("[redacted]");
  });
});

// --- /computer and live view, through the fake node ---------------------------------------

/** The fake node answers every computer call with this tiny PNG (its 8-byte signature). */
const FAKE_PNG = "iVBORw0KGgo=";

const imageOf = (r: CallToolResult) => {
  expect(r.isError).toBeFalsy();
  const img = r.content.find((c) => c.type === "image");
  return img?.type === "image" ? img : undefined;
};
const jsonOf = (r: CallToolResult): unknown => {
  const t = r.content.find((c) => c.type === "text");
  return t?.type === "text" ? JSON.parse(t.text) : undefined;
};

describe("screenshot and computer (W4 path)", () => {
  it("screenshot goes through the node, with no CDP connection", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    const shot = await call(c, "screenshot", { sessionId: s.id });
    expect(imageOf(shot)).toEqual({
      type: "image",
      mimeType: "image/png",
      data: FAKE_PNG,
    });
    expect(jsonOf(shot)).toEqual({
      ok: true,
      url: "about:blank",
      width: 1280,
      height: 720,
    });
    expect(env.nodeClient.computerCalls).toEqual([{ action: "screenshot" }]);
    expect(fake.connectUrls).toEqual([]);
  });

  it("computer sends one validated action, with defaults applied", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));

    const click = await call(c, "computer", {
      sessionId: s.id,
      action: "click",
      x: 10,
      y: 20,
      screenshot: true,
    });
    expect(imageOf(click)?.data).toBe(FAKE_PNG);
    expect(jsonOf(click)).toMatchObject({ ok: true, width: 1280 });

    const typed = await call(c, "computer", {
      sessionId: s.id,
      action: "type",
      text: "hello",
    });
    expect(imageOf(typed)).toBeUndefined();
    expect(jsonOf(typed)).toMatchObject({ ok: true });

    expect(env.nodeClient.computerCalls).toEqual([
      {
        action: "click",
        x: 10,
        y: 20,
        button: "left",
        clicks: 1,
        screenshot: true,
      },
      { action: "type", text: "hello", screenshot: false },
    ]);
  });

  it("computer refuses actions the contract refuses", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    // A click needs coordinates.
    expect(
      errorOf(
        await call(c, "computer", { sessionId: s.id, action: "click", x: 1 }),
      ),
    ).toMatchObject({ code: "invalid_request", param: "y" });
    // A field that does not apply to the action is named, not ignored.
    expect(
      errorOf(
        await call(c, "computer", {
          sessionId: s.id,
          action: "type",
          text: "a",
          x: 5,
        }),
      ),
    ).toMatchObject({ code: "invalid_request", param: "x" });
    expect(env.nodeClient.computerCalls).toEqual([]);

    await call(c, "stop_session", { sessionId: s.id });
    expect(
      errorOf(
        await call(c, "computer", {
          sessionId: s.id,
          action: "key",
          key: "Enter",
        }),
      ),
    ).toMatchObject({ code: "conflict", retryable: false });
    const other = await connect(env.project2.key);
    expect(
      errorOf(await call(other, "screenshot", { sessionId: s.id })).code,
    ).toBe("not_found");
  });

  it("passes on only a PNG of bounded size from the container", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    const answer = (screenshot: string) => {
      env.nodeClient.computer = async () => ({
        ok: true,
        response: { ok: true, width: 1, height: 1, url: "x", screenshot },
      });
    };
    answer(Buffer.from("<html>not an image</html>").toString("base64"));
    expect(errorOf(await call(c, "screenshot", { sessionId: s.id })).code).toBe(
      "internal",
    );
    answer(
      Buffer.concat([
        Buffer.from(FAKE_PNG, "base64"),
        Buffer.alloc(MCP_LIMITS.maxScreenshotBytes),
      ]).toString("base64"),
    );
    expect(
      String(errorOf(await call(c, "screenshot", { sessionId: s.id })).message),
    ).toContain("limit");
  });
});

describe("get_live_view_url", () => {
  const tokenOf = (url: string) =>
    new URLSearchParams(new URL(url).hash.slice(1)).get("token") as string;

  it("mints a view link by default, and control on request", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));

    const view = body(
      await call(c, "get_live_view_url", { sessionId: s.id }),
    ) as { url: string; scope: string; expiresAt: string };
    expect(Object.keys(view).sort()).toEqual(["expiresAt", "scope", "url"]);
    expect(view.scope).toBe("view");
    expect(view.url).toMatch(
      new RegExp(`^https://1-2-3-4\\.sslip\\.io/live/${s.id}#`),
    );
    expect(Date.parse(view.expiresAt) - env.clock.now()).toBe(10 * 60_000);
    const claims = await env.verifier.verify(
      tokenOf(view.url),
      env.clock.now(),
      ["view"],
    );
    expect(claims).toMatchObject({
      ok: true,
      claims: { sub: s.id, scope: "view" },
    });

    const control = body(
      await call(c, "get_live_view_url", {
        sessionId: s.id,
        scope: "control",
        ttlMs: 3_600_000,
        singleUse: true,
      }),
    ) as { url: string; scope: string; expiresAt: string };
    expect(control.scope).toBe("control");
    // Single use caps the lifetime at five minutes.
    expect(Date.parse(control.expiresAt) - env.clock.now()).toBe(5 * 60_000);
  });

  it("refuses an ended session and another project's", async () => {
    const c = await connect();
    const s = session(await call(c, "create_session"));
    expect(
      errorOf(
        await call(await connect(env.project2.key), "get_live_view_url", {
          sessionId: s.id,
        }),
      ).code,
    ).toBe("not_found");
    expect(
      (await call(c, "get_live_view_url", { sessionId: s.id, ttlMs: 5 }))
        .isError,
    ).toBe(true);
    await call(c, "stop_session", { sessionId: s.id });
    expect(
      errorOf(await call(c, "get_live_view_url", { sessionId: s.id })).code,
    ).toBe("conflict");
  });
});

// --- A real Chrome, when this machine has one ---------------------------------------------

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p): p is string => !!p && existsSync(p));

describe.skipIf(!CHROME)("browser tools (real Chrome over CDP)", () => {
  let chrome: ChildProcess | undefined;
  let profile = "";
  let site: Server | undefined;

  afterEach(async () => {
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((r) => chrome?.once("exit", r));
      chrome.kill("SIGKILL");
      await exited;
    }
    chrome = undefined;
    // Chrome's helper processes can still be writing to the profile for a moment.
    if (profile)
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    await new Promise((r) => (site ? site.close(r) : r(undefined)));
    site = undefined;
  });

  it("drives a page through openPageOverCdp", async () => {
    profile = mkdtempSync(join(tmpdir(), "kestrel-mcp-"));
    chrome = spawn(
      CHROME as string,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const ws = await new Promise<string>((resolve, reject) => {
      let err = "";
      chrome?.stderr?.on("data", (d: Buffer) => {
        err += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) resolve(m[1] as string);
      });
      setTimeout(() => reject(new Error(`no DevTools URL: ${err}`)), 15_000);
    });

    site = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        "<title>Kestrel test</title><body><h1>Hello from a real page</h1></body>",
      );
    });
    await new Promise<void>((r) => site?.listen(0, "127.0.0.1", r));
    const pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

    // The session's own connectUrl names a gateway that is not running here; use the local Chrome.
    await start({}, (_connectUrl, timeoutMs) => openPageOverCdp(ws, timeoutMs));
    const c = await connect();
    const s = session(await call(c, "create_session"));

    expect(
      body(await call(c, "navigate", { sessionId: s.id, url: pageUrl })),
    ).toEqual({ url: pageUrl, title: "Kestrel test", status: 200 });
    // A second connection finds the same tab where the first left it.
    expect(
      body(await call(c, "get_page_text", { sessionId: s.id })),
    ).toMatchObject({
      url: pageUrl,
      title: "Kestrel test",
      text: "Hello from a real page",
    });
  });
});
