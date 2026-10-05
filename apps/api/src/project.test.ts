import {
  AdminOrg,
  ApiKey,
  CreatedApiKey,
  ErrorResponse,
  ListAdminNodesResponse,
  ListApiKeysResponse,
  Project,
  UsageReport,
} from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "./auth.js";
import { newUuid } from "./ids.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
let adminKey: string;
beforeEach(async () => {
  await env?.close();
  env = await makeEnv();
  ({ key: adminKey } = await createApiKey(
    env.db,
    env.projectId,
    "admin",
    new Date(env.clock.now()),
    { admin: true },
  ));
});
afterAll(async () => env?.close());

const send = (
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: unknown,
) =>
  env.api.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const error = (res: { json(): unknown }) =>
  ErrorResponse.parse(res.json()).error;

describe("GET /v1/project", () => {
  it("returns the caller's project, quotas and whether the key is an admin key", async () => {
    const p = Project.parse((await send("GET", "/v1/project", env.key)).json());
    expect(p).toMatchObject({
      name: "one",
      org: { name: "test" },
      quotas: { maxConcurrentSessions: 20, createsPerMinute: 300 },
      admin: false,
    });
    const other = Project.parse(
      (await send("GET", "/v1/project", env.project2.key)).json(),
    );
    expect(other.name).toBe("two");
    expect(
      Project.parse((await send("GET", "/v1/project", adminKey)).json()).admin,
    ).toBe(true);
  });
});

describe("API keys", () => {
  it("creates a key shown once, which authenticates and is never an admin key", async () => {
    const res = await send("POST", "/v1/api-keys", env.key, { name: "ci" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const created = CreatedApiKey.parse(res.json());
    expect(created).toMatchObject({ name: "ci", admin: false });
    expect(created.key.startsWith(created.prefix)).toBe(true);
    expect((await send("GET", "/v1/project", created.key)).statusCode).toBe(
      200,
    );

    // An admin key cannot make another admin key through the API either.
    const fromAdmin = CreatedApiKey.parse(
      (await send("POST", "/v1/api-keys", adminKey, { name: "x" })).json(),
    );
    expect(fromAdmin.admin).toBe(false);
    expect(
      (await send("POST", "/v1/api-keys", env.key, { name: "x", admin: true }))
        .statusCode,
    ).toBe(400);
  });

  it("lists only the caller's project's keys, never the secret", async () => {
    const res = await send("GET", "/v1/api-keys", env.key);
    const { data } = ListApiKeysResponse.parse(res.json());
    expect(data.map((k) => k.name).sort()).toEqual(["admin", "test"]);
    expect(res.body).not.toContain(env.key);
    expect(res.body).not.toMatch(/keyHash|key_hash/);
    const other = ListApiKeysResponse.parse(
      (await send("GET", "/v1/api-keys", env.project2.key)).json(),
    );
    expect(other.data.map((k) => k.name)).toEqual(["test2"]);
  });

  it("revokes a key at once, idempotently; not itself, not another project's (G-12)", async () => {
    const created = CreatedApiKey.parse(
      (await send("POST", "/v1/api-keys", env.key, { name: "temp" })).json(),
    );
    const url = `/v1/api-keys/${created.id}/revoke`;

    // Another project cannot see it.
    const cross = await send("POST", url, env.project2.key);
    expect(cross.statusCode).toBe(404);
    expect((await send("GET", "/v1/project", created.key)).statusCode).toBe(
      200,
    );

    const first = ApiKey.parse((await send("POST", url, env.key)).json());
    expect(first.revokedAt).not.toBeNull();
    expect((await send("GET", "/v1/project", created.key)).statusCode).toBe(
      401,
    );
    env.clock.advance(60_000);
    const again = ApiKey.parse((await send("POST", url, env.key)).json());
    expect(again.revokedAt).toBe(first.revokedAt);

    // A key cannot lock itself out.
    const { data } = ListApiKeysResponse.parse(
      (await send("GET", "/v1/api-keys", env.key)).json(),
    );
    const own = data.find((k) => k.name === "test")!;
    const self = await send("POST", `/v1/api-keys/${own.id}/revoke`, env.key);
    expect(error(self)).toMatchObject({ code: "conflict", retryable: false });

    expect(
      (await send("POST", "/v1/api-keys/key_nope/revoke", env.key)).statusCode,
    ).toBe(404);
  });
});

describe("GET /v1/usage", () => {
  const DAY = 86_400_000;
  async function insertSession(
    projectId: string,
    createdAt: number,
    fields: {
      status?: "stopped" | "failed" | "ready";
      browserSeconds?: number;
      captcha?: boolean;
    } = {},
  ) {
    const key = await env.db.apiKey.findFirstOrThrow({ where: { projectId } });
    const id = newUuid();
    const status = fields.status ?? "stopped";
    await env.db.session.create({
      data: {
        id,
        projectId,
        apiKeyId: key.id,
        status,
        endReason:
          status === "stopped"
            ? "client_stop"
            : status === "failed"
              ? "start_timeout"
              : null,
        options: {},
        browserSeconds: fields.browserSeconds ?? 0,
        createdAt: new Date(createdAt),
      },
    });
    if (fields.captcha)
      await env.db.sessionEvent.create({
        data: {
          id: newUuid(),
          sessionId: id,
          type: "captcha.detected",
          data: {},
          at: new Date(createdAt),
        },
      });
  }

  it("buckets sessions and browser time by UTC day, with empty days, for the caller only", async () => {
    const now = env.clock.now(); // 2026-10-02T12:00Z
    await insertSession(env.projectId, now - 1000, { browserSeconds: 30 });
    await insertSession(env.projectId, now - 2000, {
      browserSeconds: 12.5,
      captcha: true,
    });
    await insertSession(env.projectId, now - 2 * DAY, { status: "failed" });
    await insertSession(env.projectId, now - 3000, { status: "ready" });
    await insertSession(env.projectId, now - 40 * DAY); // outside 30 days
    await insertSession(env.project2.projectId, now - 1000, {
      browserSeconds: 99,
    });

    const r = UsageReport.parse(
      (await send("GET", "/v1/usage?days=7", env.key)).json(),
    );
    expect(r.days).toHaveLength(7);
    expect(r.days[0]!.date).toBe("2026-09-26");
    expect(r.days[6]).toEqual({
      date: "2026-10-02",
      sessions: 3,
      failed: 0,
      browserSeconds: 42.5,
    });
    expect(r.days[4]).toMatchObject({
      date: "2026-09-30",
      sessions: 1,
      failed: 1,
    });
    expect(r.totals).toEqual({
      sessions: 4,
      failed: 1,
      browserSeconds: 42.5,
      captchaSessions: 1,
    });
    expect(r.live).toBe(1);
    expect(r.byEndReason).toEqual([
      { endReason: "client_stop", sessions: 2 },
      { endReason: "start_timeout", sessions: 1 },
    ]);

    const month = UsageReport.parse(
      (await send("GET", "/v1/usage", env.key)).json(),
    );
    expect(month.days).toHaveLength(30);
    expect(month.totals.sessions).toBe(4);
    expect((await send("GET", "/v1/usage?days=91", env.key)).statusCode).toBe(
      400,
    );
  });
});

describe("admin endpoints", () => {
  const paths: ["GET" | "POST", string, unknown?][] = [
    ["GET", "/v1/admin/nodes"],
    ["POST", "/v1/admin/orgs", { name: "acme" }],
    ["POST", "/v1/admin/projects", { orgId: "org_x", name: "p" }],
    ["POST", `/v1/admin/projects/prj_x/api-keys`, { name: "k" }],
  ];

  it("do not exist for a project key (T-57)", async () => {
    for (const [method, url, body] of paths) {
      const res = await send(method, url, env.key, body);
      expect(res.statusCode, url).toBe(404);
      expect(error(res).code).toBe("not_found");
    }
    expect(
      (await env.api.inject({ method: "GET", url: "/v1/admin/nodes" }))
        .statusCode,
    ).toBe(401);
  });

  it("list nodes with their live sessions", async () => {
    const created = await env.create();
    expect(created.statusCode).toBe(201);
    const { data } = ListAdminNodesResponse.parse(
      (await send("GET", "/v1/admin/nodes", adminKey)).json(),
    );
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "a",
      state: "active",
      fenced: false,
      slotsTotal: 5,
      liveSessions: 1,
    });
  });

  it("provision an org, a project with quotas and a key that works there", async () => {
    const org = AdminOrg.parse(
      (await send("POST", "/v1/admin/orgs", adminKey, { name: "acme" })).json(),
    );
    const res = await send("POST", "/v1/admin/projects", adminKey, {
      orgId: org.id,
      name: "main",
      quotas: { maxConcurrentSessions: 3 },
    });
    expect(res.statusCode).toBe(201);
    const project = Project.parse(res.json());
    expect(project).toMatchObject({
      name: "main",
      org: { id: org.id, name: "acme" },
      quotas: { maxConcurrentSessions: 3, createsPerMinute: 300 },
    });

    const dup = await send("POST", "/v1/admin/projects", adminKey, {
      orgId: org.id,
      name: "main",
    });
    expect(error(dup)).toMatchObject({ code: "conflict", param: "name" });

    const key = CreatedApiKey.parse(
      (
        await send(
          "POST",
          `/v1/admin/projects/${project.id}/api-keys`,
          adminKey,
          { name: "Dashboard (managed)" },
        )
      ).json(),
    );
    expect(key.admin).toBe(false);
    const seen = Project.parse(
      (await send("GET", "/v1/project", key.key)).json(),
    );
    expect(seen).toMatchObject({ id: project.id, admin: false });

    expect(
      (
        await send("POST", "/v1/admin/projects", adminKey, {
          orgId: "org_01h455vb4pex5vsknk084sn02q",
          name: "x",
        })
      ).statusCode,
    ).toBe(404);
  });
});
