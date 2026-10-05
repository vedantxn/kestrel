import { describe, expect, it } from "vitest";
import { KestrelApiError, createKestrelClient } from "./client";
import { liveViewResponse, recordingResponse } from "./routes";

const KEY = "ksl_" + "k".repeat(43);

/** A fetch that answers from a table and records what it was asked. */
function fakeFetch(
  routes: Record<string, (init: RequestInit) => Response>,
  seen: { url: string; init: RequestInit }[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, init });
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes[`${init.method ?? "GET"} ${path}`];
    return route
      ? route(init)
      : Response.json(
          {
            error: {
              code: "not_found",
              message: "No such session.",
              retryable: false,
              requestId: "req_x",
            },
          },
          { status: 404 },
        );
  }) as typeof fetch;
}

const project = {
  id: "prj_01m463crenefbt7jy722qa5fk2",
  name: "default",
  org: { id: "org_01m463creefqfavxk576115912", name: "default" },
  quotas: { maxConcurrentSessions: 20, createsPerMinute: 300 },
  createdAt: "2026-10-05T13:17:33.014Z",
  admin: false,
};

describe("the dashboard's API client", () => {
  it("sends the key as a bearer token and parses the response", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createKestrelClient({
      baseUrl: "http://api.test/",
      apiKey: KEY,
      fetch: fakeFetch(
        { "GET /v1/project": () => Response.json(project) },
        seen,
      ),
    });
    expect(await client.project()).toEqual(project);
    expect(seen[0]!.url).toBe("http://api.test/v1/project");
    expect(
      (seen[0]!.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${KEY}`);
  });

  it("refuses a response that does not match the contract", async () => {
    const client = createKestrelClient({
      baseUrl: "http://api.test",
      apiKey: KEY,
      fetch: fakeFetch({
        "GET /v1/project": () => Response.json({ ...project, admin: "yes" }),
      }),
    });
    await expect(client.project()).rejects.toThrow();
  });

  it("turns API errors into KestrelApiError, and a 401 into onUnauthorized", async () => {
    const client = createKestrelClient({
      baseUrl: "http://api.test",
      apiKey: KEY,
      fetch: fakeFetch({}),
    });
    const e = await client.getSession("ses_x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KestrelApiError);
    expect(e).toMatchObject({ status: 404, code: "not_found" });

    const signedOut = createKestrelClient({
      baseUrl: "http://api.test",
      apiKey: KEY,
      fetch: fakeFetch({
        "GET /v1/project": () => new Response("{}", { status: 401 }),
      }),
      onUnauthorized: () => {
        throw new Error("redirected");
      },
    });
    await expect(signedOut.project()).rejects.toThrow("redirected");
  });
});

describe("route helpers (T-56)", () => {
  const id = "ses_01m463e1yjf0avhvfp2y0r2xcr";

  it("sends live view to the viewer page with a minted token, never cached", async () => {
    let body: unknown;
    const client = createKestrelClient({
      baseUrl: "http://api.test",
      apiKey: KEY,
      fetch: fakeFetch({
        [`POST /v1/sessions/${id}/tokens`]: (init) => {
          body = JSON.parse(String(init.body));
          return Response.json({
            scope: "control",
            token: "t",
            url: `https://h/live/${id}#token=t`,
            expiresAt: "2026-10-05T14:00:00.000Z",
          });
        },
      }),
    });
    const res = await liveViewResponse(client, id, true);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://h/live/${id}#token=t`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ scope: "control", ttlMs: 30 * 60_000 });

    const gone = await liveViewResponse(
      createKestrelClient({
        baseUrl: "http://api.test",
        apiKey: KEY,
        fetch: fakeFetch({}),
      }),
      id,
      false,
    );
    expect(gone.status).toBe(404);
  });

  it("serves a recording only as a download", async () => {
    const client = createKestrelClient({
      baseUrl: "http://api.test",
      apiKey: KEY,
      fetch: fakeFetch({
        [`GET /v1/sessions/${id}/recording`]: () =>
          new Response("mp4", {
            headers: { "content-type": "text/html", "content-length": "3" },
          }),
      }),
    });
    const res = await recordingResponse(client, id);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${id}.mp4"`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("mp4");
  });
});
