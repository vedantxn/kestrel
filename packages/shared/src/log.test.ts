import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./log.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { text: () => lines.join(""), stream };
}

describe("log redaction", () => {
  it("never writes tokens, keys, proofs or credential headers", () => {
    const { text, stream } = capture();
    const log = createLogger("t", "info", stream);
    const key = "ksl_" + "A".repeat(43);
    const jwt = "eyJhbGciOiJFZERTQSJ9.payload.signature";
    const proof = "ab".repeat(32);
    log.info(
      {
        req: {
          method: "GET",
          url: `/v1/sessions/ses_x/cdp?token=${jwt}&a=1`,
          id: "r1",
        },
        headers: { authorization: `Bearer ${key}`, "x-api-key": key },
        route: { token: jwt, proof, secret: "s3cret" },
        client: { apiKey: key },
      },
      "request",
    );
    const out = text();
    for (const secret of [key, jwt, proof, "s3cret"])
      expect(out).not.toContain(secret);
    expect(out).toContain("/v1/sessions/ses_x/cdp");
    expect(out).toContain("[redacted]");
  });

  it("logs the path without any query string", () => {
    const { text, stream } = capture();
    createLogger("t", "info", stream).info(
      { req: { method: "GET", url: "/v1/sessions?limit=5&token=abc" } },
      "x",
    );
    expect(text()).toContain('"url":"/v1/sessions"');
    expect(text()).not.toContain("limit=5");
  });
});
