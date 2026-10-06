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

  it("never writes a CAPTCHA solver's key, at any depth a start request nests it", () => {
    const { text, stream } = capture();
    const log = createLogger("t", "info", stream);
    const apiKey = "s0lver-key-xyz";
    log.info({ apiKey }, "depth 0");
    log.info({ solver: { apiKey } }, "1");
    log.info({ captcha: { solver: { apiKey } } }, "2");
    log.info({ req: { captcha: { solver: { apiKey } } } }, "3");
    log.info({ body: { clientKey: apiKey } }, "service request");
    log.info({ clientKey: apiKey }, "service request");
    expect(text()).not.toContain(apiKey);
  });

  it("never writes an upstream proxy's password or Proxy-Authorization", () => {
    const { text, stream } = capture();
    const log = createLogger("t", "info", stream);
    const password = "pr0xy-pa55";
    const basic = "Basic " + Buffer.from(`user:${password}`).toString("base64");
    log.info({ password }, "depth 0");
    log.info({ proxy: { server: "http://p.example:3128", password } }, "1");
    log.info({ req: { network: { upstream: { password } } } }, "depth 3");
    log.info({ start: { network: { upstream: { password } } } }, "depth 3");
    log.info({ headers: { "proxy-authorization": basic } }, "headers");
    log.info({ upstream: { authorization: basic } }, "entry");
    log.info({ policy: { upstream: { authorization: basic } } }, "entry");
    const out = text();
    expect(out).not.toContain(password);
    expect(out).not.toContain(basic);
    expect(out).toContain("http://p.example:3128");
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
