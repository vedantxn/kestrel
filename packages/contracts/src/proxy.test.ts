import { describe, expect, it } from "vitest";
import { EgressPolicy } from "./egress-control.js";
import { StartNetwork, StartRequest } from "./node-protocol.js";
import {
  parseProxyHost,
  parseProxyServer,
  ProxyConfig,
  SessionProxy,
  splitProxy,
  UpstreamProxy,
} from "./proxy.js";
import { CreateSessionRequest, NetworkPolicy, Session } from "./session.js";

const ses = "ses_01h0000000000000000000000a";
const prj = "prj_01h0000000000000000000000a";

describe("proxy server", () => {
  it("accepts http://host:port with a hostname or IPv4 address", () => {
    expect(parseProxyServer("http://proxy.example.com:3128")).toEqual({
      scheme: "http",
      host: "proxy.example.com",
      port: 3128,
    });
    expect(parseProxyServer("http://1.2.3.4:8080")).toEqual({
      scheme: "http",
      host: "1.2.3.4",
      port: 8080,
    });
    expect(parseProxyServer("HTTP://Proxy.Example.COM:22225/")).toEqual({
      scheme: "http",
      host: "proxy.example.com",
      port: 22225,
    });
  });

  it("accepts https:// (TLS to the proxy) and socks5://", () => {
    expect(parseProxyServer("https://proxy.example.com:443")).toEqual({
      scheme: "https",
      host: "proxy.example.com",
      port: 443,
    });
    expect(parseProxyServer("SOCKS5://1.2.3.4:1080")).toEqual({
      scheme: "socks5",
      host: "1.2.3.4",
      port: 1080,
    });
  });

  it.each([
    "socks4://proxy.example.com:1080",
    "socks5h://proxy.example.com:1080",
    "socks://proxy.example.com:1080",
    "ftp://proxy.example.com:3128",
    "https://proxy.example.com",
    "socks5://proxy.example.com:25",
    "socks5://user:pw@proxy.example.com:1080",
    "proxy.example.com:3128",
    "http://proxy.example.com",
    "http://proxy.example.com:0",
    "http://proxy.example.com:65536",
    "http://proxy.example.com:03128",
    "http://proxy.example.com:3128/path",
    "http://proxy.example.com:3128?x=1",
    "http://proxy.example.com:3128#f",
    "http://user:pass@proxy.example.com:3128",
    "http://[::1]:3128",
    "http://1.2.3:3128",
    "http://0x7f.1:3128",
    "http://127.1:3128",
    "http://proxy.example.com.:3128",
    "http://-bad.example.com:3128",
    "http://proxy_example.com:3128",
    "http://proxy.example.com:25", // SMTP: a Fetch bad port (T-48)
    "http://proxy.example.com:22",
    "http://proxy.example.com:6667",
    " http://proxy.example.com:3128",
  ])("refuses %s", (server) => {
    expect(parseProxyServer(server)).toBeNull();
    expect(ProxyConfig.safeParse({ server }).success).toBe(false);
  });

  it("says why an unsupported scheme is refused", () => {
    const r = ProxyConfig.safeParse({ server: "socks4://p.example.com:1080" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "only http://, https:// and socks5:// proxies are supported",
    );
    const h = ProxyConfig.safeParse({ server: "socks5h://p.example.com:1080" });
    expect(JSON.stringify(h.error?.issues)).toContain("use socks5://");
  });

  it("allows common proxy ports", () => {
    for (const port of [80, 443, 1080, 3128, 8000, 8080, 8888, 9999, 22225])
      expect(parseProxyServer(`http://p.example.com:${port}`)).not.toBeNull();
  });

  it("parses hosts strictly", () => {
    expect(parseProxyHost("Example.COM")).toBe("example.com");
    expect(parseProxyHost("256.1.1.1")).toBeNull();
    expect(parseProxyHost("a".repeat(64) + ".com")).toBeNull();
  });
});

describe("proxy credentials", () => {
  const server = "http://p.example.com:3128";

  it("needs a username for a password, and no ':' in the username", () => {
    expect(ProxyConfig.safeParse({ server, password: "x" }).success).toBe(
      false,
    );
    expect(
      ProxyConfig.safeParse({ server, username: "a:b", password: "x" }).success,
    ).toBe(false);
    expect(
      ProxyConfig.safeParse({ server, username: "a", password: "x:y" }).success,
    ).toBe(true);
    expect(ProxyConfig.safeParse({ server, username: "a" }).success).toBe(true);
  });

  it("refuses control characters, overlong values and unknown fields", () => {
    expect(
      ProxyConfig.safeParse({ server, username: "a\r\nX-Evil: 1" }).success,
    ).toBe(false);
    expect(
      ProxyConfig.safeParse({ server, username: "a", password: "p\u0000" })
        .success,
    ).toBe(false);
    expect(
      ProxyConfig.safeParse({ server, username: "a".repeat(256) }).success,
    ).toBe(false);
    expect(ProxyConfig.safeParse({ server, bypass: "localhost" }).success).toBe(
      false,
    );
  });

  it("never keeps a password in the stored view", () => {
    expect(
      SessionProxy.safeParse({ server, username: "a", password: "x" }).success,
    ).toBe(false);
    const { stored, upstream } = splitProxy({
      server: "HTTP://P.Example.com:3128/",
      username: "a",
      password: "s3cret",
    });
    expect(stored).toEqual({
      server: "http://p.example.com:3128",
      username: "a",
    });
    expect(JSON.stringify(stored)).not.toContain("s3cret");
    expect(upstream).toEqual({
      host: "p.example.com",
      port: 3128,
      username: "a",
      password: "s3cret",
    });
  });

  it("is part of a create request and of the session's options", () => {
    const r = CreateSessionRequest.parse({
      proxy: { server, username: "a", password: "x" },
    });
    expect(r.proxy?.password).toBe("x");
    const shape = Session.shape.options.shape.proxy;
    expect(shape.safeParse({ server, username: "a" }).success).toBe(true);
    expect(shape.safeParse({ server, password: "x" }).success).toBe(false);
  });
});

describe("internal schemas fail closed (T-47)", () => {
  const upstream = {
    host: "p.example.com",
    port: 3128,
    username: "a",
    password: "x",
  };

  it("a node from before upstream proxies refuses the nested field", () => {
    // Its `network` schema was `NetworkPolicy`: strict, so the start is refused.
    expect(NetworkPolicy.safeParse({ upstream }).success).toBe(false);
    expect(StartNetwork.safeParse({ upstream }).success).toBe(true);
    expect(StartNetwork.safeParse({ upstream, other: 1 }).success).toBe(false);
  });

  it("the start request and the egress policy are strict", () => {
    const start = {
      sessionId: ses,
      projectId: prj,
      epoch: 1,
      viewport: { width: 1280, height: 720 },
      network: { upstream },
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      stopOnDisconnect: false,
    };
    expect(StartRequest.safeParse(start).success).toBe(true);
    expect(StartRequest.safeParse({ ...start, extra: 1 }).success).toBe(false);
    expect(EgressPolicy.safeParse({ sessionId: ses, upstream }).success).toBe(
      true,
    );
    expect(EgressPolicy.safeParse({ sessionId: ses, extra: 1 }).success).toBe(
      false,
    );
  });

  it("a node or gateway from before TLS and SOCKS5 refuses those upstreams", () => {
    // Its UpstreamProxy had no `scheme`, and was strict.
    const before = UpstreamProxy.omit({ scheme: true });
    expect(before.safeParse(upstream).success).toBe(true);
    expect(before.safeParse({ ...upstream, scheme: "socks5" }).success).toBe(
      false,
    );
    expect(
      UpstreamProxy.safeParse({ ...upstream, scheme: "http" }).success,
    ).toBe(false);
  });

  it("an upstream host must already be canonical", () => {
    expect(
      UpstreamProxy.safeParse({ ...upstream, host: "P.example.com" }).success,
    ).toBe(false);
    expect(
      UpstreamProxy.safeParse({ ...upstream, host: "10.0.0.1:80" }).success,
    ).toBe(false);
  });
});
