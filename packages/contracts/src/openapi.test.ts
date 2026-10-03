import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.js";

const committed = resolve(
  fileURLToPath(import.meta.url),
  "../../../../docs/api/openapi.json",
);

describe("openapi", () => {
  it("is a valid OpenAPI document with every reference resolvable", async () => {
    const doc = JSON.parse(JSON.stringify(buildOpenApiDocument()));
    await expect(SwaggerParser.validate(doc)).resolves.toBeTruthy();
  });

  it("documents exactly the endpoints in the plan (A1, W1, W4)", () => {
    const paths = Object.entries(
      buildOpenApiDocument().paths as Record<string, object>,
    ).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(paths.sort()).toEqual(
      [
        "POST /v1/sessions",
        "GET /v1/sessions",
        "GET /v1/sessions/{id}",
        "POST /v1/sessions/{id}/stop",
        "GET /v1/sessions/{id}/events",
        "POST /v1/sessions/{id}/tokens",
        "POST /v1/sessions/{id}/computer",
        "GET /healthz",
        "GET /openapi.json",
      ].sort(),
    );
  });

  it("matches docs/api/openapi.json (run `npm run openapi` after changing a schema)", () => {
    const onDisk = JSON.parse(readFileSync(committed, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});
