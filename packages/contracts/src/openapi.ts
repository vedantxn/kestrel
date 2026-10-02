import { z } from "zod";
import { HTTP_STATUS_FOR_ERROR } from "./errors.js";
import "./events.js"; // registers the event schemas
import "./session.js"; // registers the session schemas

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
