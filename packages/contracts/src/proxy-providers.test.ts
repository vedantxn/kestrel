import { describe, expect, it } from "vitest";
import { ProxyConfig, resolveTimezone, splitProxy } from "./proxy.js";

const parse = (p: object) => ProxyConfig.safeParse(p);
const sent = (p: object) => splitProxy(ProxyConfig.parse(p)).upstream;
const messages = (p: object): string => {
  const r = parse(p);
  return r.success ? "" : JSON.stringify(r.error.issues);
};

describe("generic (no adapter)", () => {
  const server = "http://p.example.com:8080";

  it("sends the credentials unchanged, and keeps country as a declaration", () => {
    expect(
      sent({ server, username: "u", password: "pw", country: "DE" }),
    ).toEqual({
      host: "p.example.com",
      port: 8080,
      username: "u",
      password: "pw",
    });
    expect(
      sent({ server, provider: "generic", username: "u", password: "pw" }),
    ).toEqual({
      host: "p.example.com",
      port: 8080,
      username: "u",
      password: "pw",
    });
  });

  it("refuses region, city and sticky, which it could not ask for", () => {
    for (const k of ["region", "city", "sticky"])
      expect(
        messages({ server, username: "u", country: "US", [k]: "abc" }),
      ).toContain("needs a provider adapter");
  });

  it("validates country strictly", () => {
    for (const country of ["us", "USA", "XX", "UK", "", "D"])
      expect(parse({ server, country }).success).toBe(false);
    expect(parse({ server, country: "GB" }).success).toBe(true);
  });

  it("needs country for region and city, and sticky for stickyMinutes", () => {
    expect(
      messages({ server, provider: "decodo", username: "u", city: "paris" }),
    ).toContain("region and city need country");
    expect(
      messages({
        server,
        provider: "decodo",
        username: "u",
        stickyMinutes: 5,
      }),
    ).toContain("stickyMinutes needs sticky");
  });
});

describe("Bright Data", () => {
  const server = "http://brd.superproxy.io:33335";
  const username = "brd-customer-hl_1234abcd-zone-residential";

  it("appends country, state, city and session to the issued username", () => {
    expect(
      sent({
        server,
        provider: "brightdata",
        username,
        password: "zonepw",
        country: "US",
        region: "NY",
        city: "New York",
        sticky: "abc123",
      }),
    ).toEqual({
      host: "brd.superproxy.io",
      port: 33335,
      username: `${username}-country-us-state-ny-city-newyork-session-abc123`,
      password: "zonepw",
    });
  });

  it("refuses a username it did not issue, a state name, and a duration", () => {
    expect(
      messages({ server, provider: "brightdata", username: "bob" }),
    ).toContain("brd-customer-<id>-zone-<zone>");
    expect(
      messages({
        server,
        provider: "brightdata",
        username,
        country: "US",
        region: "california",
      }),
    ).toContain("ISO 3166-2");
    expect(
      messages({
        server,
        provider: "brightdata",
        username,
        sticky: "a1",
        stickyMinutes: 10,
      }),
    ).toContain("no session duration");
  });

  it("stores the username as given, not the one sent", () => {
    const { stored } = splitProxy(
      ProxyConfig.parse({
        server,
        provider: "brightdata",
        username,
        password: "zonepw",
        country: "FR",
        sticky: "s1",
      }),
    );
    expect(stored).toEqual({
      server: "http://brd.superproxy.io:33335",
      username,
      provider: "brightdata",
      country: "FR",
      sticky: "s1",
    });
  });
});

describe("Oxylabs", () => {
  const server = "http://pr.oxylabs.io:7777";

  it("prefixes customer-, then cc, city, sessid and sesstime", () => {
    expect(
      sent({
        server,
        provider: "oxylabs",
        username: "acme",
        password: "pw",
        country: "US",
        city: "Los Angeles",
        sticky: "abcd1234",
        stickyMinutes: 30,
      }).username,
    ).toBe("customer-acme-cc-US-city-los_angeles-sessid-abcd1234-sesstime-30");
    expect(
      sent({ server, provider: "oxylabs", username: "customer-acme" }).username,
    ).toBe("customer-acme");
  });

  it("writes a US state as st-us_<name>, without cc", () => {
    expect(
      sent({
        server,
        provider: "oxylabs",
        username: "acme",
        country: "US",
        region: "new york",
      }).username,
    ).toBe("customer-acme-st-us_new_york");
    expect(
      messages({
        server,
        provider: "oxylabs",
        username: "acme",
        country: "DE",
        region: "bavaria",
      }),
    ).toContain("US only");
    expect(
      messages({
        server,
        provider: "oxylabs",
        username: "acme",
        country: "US",
        region: "texas",
        city: "austin",
      }),
    ).toContain("not both");
  });
});

describe("Decodo", () => {
  const server = "http://gate.decodo.com:7000";

  it("prefixes user-, then country, state, city, session and duration", () => {
    expect(
      sent({
        server,
        provider: "decodo",
        username: "acme",
        password: "pw",
        country: "US",
        region: "Texas",
        city: "austin",
        sticky: "random123",
        stickyMinutes: 60,
      }).username,
    ).toBe(
      "user-acme-country-us-state-us_texas-city-austin-session-random123-sessionduration-60",
    );
  });

  it("refuses a non-US state and non-ASCII place names", () => {
    expect(
      messages({
        server,
        provider: "decodo",
        username: "acme",
        country: "FR",
        region: "bretagne",
      }),
    ).toContain("US only");
    expect(
      messages({
        server,
        provider: "decodo",
        username: "acme",
        country: "DE",
        city: "München",
      }),
    ).toContain("ASCII");
  });

  it("needs a username", () => {
    expect(messages({ server, provider: "decodo", country: "US" })).toContain(
      "needs your decodo username",
    );
  });
});

describe("IPRoyal", () => {
  const server = "http://geo.iproyal.com:12321";

  it("writes the exit into the password", () => {
    expect(
      sent({
        server,
        provider: "iproyal",
        username: "acme",
        password: "secret",
        country: "BR",
        city: "Recife",
        sticky: "sgn34f3e",
        stickyMinutes: 10,
      }),
    ).toEqual({
      host: "geo.iproyal.com",
      port: 12321,
      username: "acme",
      password: "secret_country-br_city-recife_session-sgn34f3e_lifetime-10m",
    });
  });

  it("needs a password, an 8-character session and one-word places", () => {
    expect(
      messages({
        server,
        provider: "iproyal",
        username: "acme",
        country: "US",
      }),
    ).toContain("writes the exit into the password");
    expect(
      messages({
        server,
        provider: "iproyal",
        username: "acme",
        password: "pw",
        sticky: "abc",
      }),
    ).toContain("exactly 8");
    expect(
      messages({
        server,
        provider: "iproyal",
        username: "acme",
        password: "pw",
        country: "US",
        city: "new york",
      }),
    ).toContain("one word");
  });

  it("refuses an exit that would make the password too long", () => {
    expect(
      messages({
        server,
        provider: "iproyal",
        username: "acme",
        password: "p".repeat(250),
        country: "US",
      }),
    ).toContain("the password with the exit request added");
  });
});

describe("SOCKS5 credentials (RFC 1929)", () => {
  const server = "socks5://s.example.com:1080";

  it("needs a password with a username, and at most 255 bytes each", () => {
    expect(messages({ server, username: "u" })).toContain("needs a password");
    expect(parse({ server, username: "u", password: "p" }).success).toBe(true);
    expect(parse({ server }).success).toBe(true);
    // 128 two-byte characters: 128 characters, 256 bytes.
    expect(
      messages({ server, username: "é".repeat(128), password: "p" }),
    ).toContain("255 bytes");
  });

  it("is sent with its scheme; an http proxy is sent without one", () => {
    expect(sent({ server, username: "u", password: "p" })).toEqual({
      scheme: "socks5",
      host: "s.example.com",
      port: 1080,
      username: "u",
      password: "p",
    });
    expect(sent({ server: "https://s.example.com:443" })).toEqual({
      scheme: "https",
      host: "s.example.com",
      port: 443,
    });
    expect(sent({ server: "http://s.example.com:3128" })).toEqual({
      host: "s.example.com",
      port: 3128,
    });
  });
});

describe("time zone from the exit", () => {
  it("defaults from a country with one clear zone, never overrides an explicit one", () => {
    expect(resolveTimezone(undefined, { country: "DE" })).toBe("Europe/Berlin");
    expect(resolveTimezone(undefined, { country: "US" })).toBeUndefined();
    expect(resolveTimezone("America/Chicago", { country: "DE" })).toBe(
      "America/Chicago",
    );
    expect(resolveTimezone(undefined, undefined)).toBeUndefined();
  });
});
