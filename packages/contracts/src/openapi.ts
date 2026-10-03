import { z } from "zod";
import { HTTP_STATUS_FOR_ERROR } from "./errors.js";
import "./events.js"; // registers the event schemas
import "./session.js"; // registers the session schemas
import "./tokens.js"; // MintTokenRequest, SessionToken (W1)
import "./computer.js"; // ComputerRequest, ComputerResponse (W4)

/**
 * The public API's OpenAPI document, generated from the same Zod schemas the API validates
 * with. It is the public contract (C1): the committed copy at `docs/api/openapi.json` is
 * checked against this function in CI, so a schema change that is not reflected there fails.
 */
export const API_VERSION = "0.1.0";

type Json = Record<string, unknown>;

/**
 * Every schema with a `meta({ id })` becomes `components.schemas[id]`, referenced by `$ref`.
 * Responses use the output form (defaults applied); the two request schemas use the input
 * form (defaults optional). Every other schema is the same in both forms.
 */
function componentSchemas(): Record<string, Json> {
  const convert = (io: "input" | "output") => {
    const out = z.toJSONSchema(z.globalRegistry, {
      target: "draft-2020-12",
      io,
      unrepresentable: "any",
      uri: (id) => `#/components/schemas/${id}`,
      override: ({ jsonSchema }) => {
        // Zod's date-time pattern is a page-long regex; the format says it already.
        if (jsonSchema.format === "date-time") delete jsonSchema.pattern;
      },
    }).schemas as Record<string, Json>;
    for (const schema of Object.values(out)) {
      delete schema.$schema;
      delete schema.$id;
    }
    return out;
  };
  const out = convert("output");
  const inp = convert("input");
  return {
    ...out,
    CreateSessionRequest: inp.CreateSessionRequest!,
    ListSessionsQuery: inp.ListSessionsQuery!,
    ListEventsQuery: inp.ListEventsQuery!,
    MintTokenRequest: inp.MintTokenRequest!,
    ComputerRequest: inp.ComputerRequest!,
  };
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (name: string): Json => ({
  content: { "application/json": { schema: ref(name) } },
});

function queryParams(schemas: Record<string, Json>, name: string): Json[] {
  const s = schemas[name] as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(s.properties ?? {}).map(([paramName, schema]) => ({
    name: paramName,
    in: "query",
    required: s.required?.includes(paramName) ?? false,
    schema,
  }));
}

const sessionIdParam: Json = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^ses_[0-7][0-9a-hjkmnp-tv-z]{25}$" },
};

const errorRef = (description: string): Json => ({
  description,
  ...jsonBody("ErrorResponse"),
});

export function buildOpenApiDocument(): Json {
  const schemas = componentSchemas();
  const errors = (...codes: (keyof typeof HTTP_STATUS_FOR_ERROR)[]): Json =>
    Object.fromEntries(
      codes.map((c) => [String(HTTP_STATUS_FOR_ERROR[c]), errorRef(c)]),
    );

  return {
    openapi: "3.1.0",
    info: {
      title: "Kestrel API",
      version: API_VERSION,
      description:
        "Cloud browsers for AI agents. Create a session, then connect any CDP client (Playwright, Puppeteer) to its `connectUrl`. Durations are milliseconds. Errors have one shape; branch on `code` and `retryable`.",
    },
    security: [{ bearer: [] }, { apiKey: [] }],
    components: {
      schemas,
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "`Authorization: Bearer ksl_...`",
        },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    paths: {
      "/v1/sessions": {
        post: {
          operationId: "createSession",
          summary: "Create a session",
          description:
            "Returns when the browser is ready to connect to. `capacity_exhausted` (503) means the platform is full; `quota_exceeded` (429) means the project is over its limit. With `waitForCapacityMs` a full platform is retried before answering.",
          requestBody: { required: true, ...jsonBody("CreateSessionRequest") },
          responses: {
            "201": {
              description: "The session, ready.",
              ...jsonBody("Session"),
            },
            "200": {
              description:
                "An earlier request with the same idempotencyKey: the original session, in its current state.",
              ...jsonBody("Session"),
            },
            ...errors(
              "invalid_request",
              "unauthorized",
              "conflict",
              "quota_exceeded",
              "capacity_exhausted",
              "internal",
            ),
          },
        },
        get: {
          operationId: "listSessions",
          summary: "List sessions, newest first",
          parameters: queryParams(schemas, "ListSessionsQuery"),
          responses: {
            "200": {
              description: "A page of sessions.",
              ...jsonBody("ListSessionsResponse"),
            },
            ...errors("invalid_request", "unauthorized", "internal"),
          },
        },
      },
      "/v1/sessions/{id}": {
        get: {
          operationId: "getSession",
          summary: "Get a session",
          parameters: [sessionIdParam],
          responses: {
            "200": { description: "The session.", ...jsonBody("Session") },
            ...errors("unauthorized", "not_found", "internal"),
          },
        },
      },
      "/v1/sessions/{id}/stop": {
        post: {
          operationId: "stopSession",
          summary: "Stop a session",
          description:
            "Idempotent. Returns at once with the session in `stopping` (or already ended); teardown continues in the background.",
          parameters: [sessionIdParam],
          responses: {
            "200": { description: "The session.", ...jsonBody("Session") },
            ...errors("unauthorized", "not_found", "internal"),
          },
        },
      },
      "/v1/sessions/{id}/tokens": {
        post: {
          operationId: "mintSessionToken",
          summary: "Mint a token for a running session",
          description:
            "`cdp` re-issues the connect URL. `view` opens live view (frames only) and `control` opens it with mouse and keyboard; both default to 10 minutes and may be up to 1 hour, never past the session's own deadline plus one minute. `singleUse` tokens open one connection and live at most 5 minutes. For `view` and `control`, `url` is a viewer page with the token in the URL fragment; open it in a browser or an iframe-free tab.",
          parameters: [sessionIdParam],
          requestBody: { required: true, ...jsonBody("MintTokenRequest") },
          responses: {
            "201": { description: "The token.", ...jsonBody("SessionToken") },
            ...errors(
              "invalid_request",
              "unauthorized",
              "not_found",
              "conflict",
              "internal",
            ),
          },
        },
      },
      "/v1/sessions/{id}/recording": {
        get: {
          operationId: "getSessionRecording",
          summary: "A session's video",
          description:
            "Fragmented MP4 of the browser window, for a session created with `recording: true`. Available while the session runs (up to its latest fragment) and for 24 hours after it ends, from the node it ran on. 404 if the session was not recorded, its node could not record, or the recording has been removed.",
          parameters: [sessionIdParam],
          responses: {
            "200": {
              description: "The video.",
              content: {
                "video/mp4": { schema: { type: "string", format: "binary" } },
              },
            },
            ...errors("unauthorized", "not_found", "internal"),
          },
        },
      },
      "/v1/sessions/{id}/computer": {
        post: {
          operationId: "sessionComputer",
          summary: "Screenshot, mouse and keyboard over HTTP",
          description:
            "One action per call on the session's current page, no CDP client needed. Coordinates are CSS pixels of the page (see `width` and `height` in the response). Each call counts as activity for `idleTimeout`. Any action except `screenshot` may set `screenshot: true` to get a PNG of the result.",
          parameters: [sessionIdParam],
          requestBody: { required: true, ...jsonBody("ComputerRequest") },
          responses: {
            "200": {
              description: "The action ran.",
              ...jsonBody("ComputerResponse"),
            },
            ...errors(
              "invalid_request",
              "unauthorized",
              "not_found",
              "conflict",
              "internal",
            ),
          },
        },
      },
      "/v1/sessions/{id}/events": {
        get: {
          operationId: "listSessionEvents",
          summary: "A session's timeline",
          parameters: [
            sessionIdParam,
            ...queryParams(schemas, "ListEventsQuery"),
          ],
          responses: {
            "200": {
              description: "A page of events, oldest first.",
              ...jsonBody("ListEventsResponse"),
            },
            ...errors(
              "invalid_request",
              "unauthorized",
              "not_found",
              "internal",
            ),
          },
        },
      },
      "/healthz": {
        get: {
          operationId: "health",
          summary: "Liveness",
          security: [],
          responses: {
            "200": {
              description: "The API process is up.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { const: "ok" } },
                    required: ["status"],
                  },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "openapi",
          summary: "This document",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1" } },
        },
      },
    },
  };
}
