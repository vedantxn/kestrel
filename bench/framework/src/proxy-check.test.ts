import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyConfig, splitProxy } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import {
  adapterCases,
  bytesVerdict,
  proxyCheckConfigFromEnv,
  sameZone,
} from "./proxy-check.js";

describe("bench proxy's expectations", () => {
  it("the adapter strings written out by hand match what the API sends the proxy", () => {
    for (const a of adapterCases("k")) {
      const p = ProxyConfig.parse({
        server: "http://203.0.113.9:3129",
        username: "k",
        password: "pw",
        ...a.request,
      });
      const { upstream } = splitProxy(p);
      expect(upstream.username).toBe(a.username);
      expect(upstream.password).toBe(`pw${a.passwordExtra}`);
    }
  });

  it("each adapter-written username still contains the test proxy's user", () => {
    for (const a of adapterCases("k")) expect(a.username).toContain("k");
  });

  it("treats a zone and Chrome's older alias for it as the same, and different zones as different", () => {
    expect(sameZone("Europe/Berlin", "Europe/Berlin")).toBe(true);
    expect(sameZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
    expect(sameZone("Europe/Kiev", "Europe/Kyiv")).toBe(true);
    // The same offsets all year are not the same zone.
    expect(sameZone("Europe/Paris", "Europe/Berlin")).toBe(false);
    expect(sameZone("UTC", "Europe/Berlin")).toBe(false);
  });

  it("wants at least the download, not much more, and something up", () => {
    const n = 5_000_000;
    expect(
      bytesVerdict({ egressBytesUp: 2_000, egressBytesDown: n + 40_000 }, n),
    ).toBeNull();
    expect(
      bytesVerdict({ egressBytesUp: 2_000, egressBytesDown: n - 1 }, n),
    ).toMatch(/less than/);
    expect(
      bytesVerdict({ egressBytesUp: 2_000, egressBytesDown: 3 * n }, n),
    ).toMatch(/more than/);
    expect(bytesVerdict({ egressBytesUp: 0, egressBytesDown: n }, n)).toMatch(
      /Up is 0/,
    );
  });

  it("reads the SOCKS5 and TLS proxies from the environment, optionally", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-check-"));
    writeFileSync(join(dir, "key"), "ksl_x\n");
    const base = {
      PUBLIC_HOSTNAME: "kestrel.example.com",
      API_KEY_FILE: join(dir, "key"),
      TEST_PAGE_URL: "https://example.com/",
      PROXY_SERVER: "http://203.0.113.9:3129",
      PROXY_USERNAME: "k",
      PROXY_PASSWORD: "pw",
      EXPECT_EXIT_IP: "203.0.113.9",
      PUBLIC_IP: "198.51.100.1",
      UNREACHABLE_PROXY: "http://203.0.113.9:3130",
    };
    const plain = proxyCheckConfigFromEnv(base, () => undefined);
    expect(plain.socksProxyServer).toBeUndefined();
    const all = proxyCheckConfigFromEnv(
      {
        ...base,
        SOCKS_PROXY_SERVER: "socks5://203.0.113.9:1081",
        TLS_PROXY_SERVER: "https://proxy.example.com:3132",
        TLS_UNTRUSTED_PROXY: "https://203.0.113.9:3133",
      },
      () => undefined,
    );
    expect(all).toMatchObject({
      socksProxyServer: "socks5://203.0.113.9:1081",
      tlsProxyServer: "https://proxy.example.com:3132",
      untrustedTlsProxy: "https://203.0.113.9:3133",
    });
  });
});
