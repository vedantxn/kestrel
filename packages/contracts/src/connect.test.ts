import { describe, expect, it } from "vitest";
import {
  buildConnectUrl,
  buildLiveViewUrl,
  cdpBasePath,
  cdpBaseUrl,
  matchGatewayPath,
  parsePublicUrl,
  redactToken,
  securePublicEndpoint,
} from "./connect.js";
import { newId } from "./ids.js";

const id = newId("ses");

describe("connect paths", () => {
  it("builds the connect url", () => {
    const url = new URL(
      buildConnectUrl(
        securePublicEndpoint("1-2-3-4.sslip.io"),
        8443,
        id,
        "a.b+c",
      ),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.port).toBe("8443");
    expect(url.pathname).toBe(`/v1/sessions/${id}/cdp`);
    expect(url.searchParams.get("token")).toBe("a.b+c");
  });

  it("uses ws:// and http:// in local mode", () => {
    const local = parsePublicUrl("http://192.168.1.10");
    expect(buildConnectUrl(local, 8443, id, "t")).toBe(
      `ws://192.168.1.10:8443/v1/sessions/${id}/cdp?token=t`,
    );
    const live = new URL(buildLiveViewUrl(local, 8443, id, "t"));
    expect(live.origin).toBe("http://192.168.1.10");
    expect(live.pathname).toBe(`/live/${id}`);
    const fragment = new URLSearchParams(live.hash.slice(1));
    expect(fragment.get("ws")).toBe(
      `ws://192.168.1.10:8443/v1/sessions/${id}/live`,
    );
    expect(fragment.get("token")).toBe("t");
  });

  it("keeps the web origin's port and brackets IPv6", () => {
    const e = parsePublicUrl("http://[fd00::1]:8088/");
    expect(e).toEqual({
      secure: false,
      host: "[fd00::1]",
      webOrigin: "http://[fd00::1]:8088",
    });
    expect(cdpBaseUrl(e.secure, e.host, 8443, id)).toBe(
      `ws://[fd00::1]:8443/v1/sessions/${id}/cdp`,
    );
    expect(
      buildLiveViewUrl(e, 8443, id, "t").startsWith(
        `http://[fd00::1]:8088/live/${id}#`,
      ),
    ).toBe(true);
    expect(parsePublicUrl("https://kestrel.example.com")).toEqual({
      secure: true,
      host: "kestrel.example.com",
      webOrigin: "https://kestrel.example.com",
    });
  });

  it("refuses public URLs it cannot build from", () => {
    for (const bad of [
      "kestrel.example.com",
      "ftp://kestrel.example.com",
      "https://user:pw@kestrel.example.com",
      "https://kestrel.example.com/api",
      "https://kestrel.example.com/?a=1",
      "https://kestrel.example.com/#x",
    ])
      expect(() => parsePublicUrl(bad), bad).toThrow();
  });

  it("recognises the whole path family", () => {
    const base = cdpBasePath(id);
    expect(matchGatewayPath(base)).toEqual({
      kind: "browser-socket",
      sessionId: id,
    });
    expect(matchGatewayPath(`${base}/`)).toEqual({
      kind: "browser-socket",
      sessionId: id,
    });
    expect(matchGatewayPath(`${base}/json/version`)?.kind).toBe("json-version");
    expect(matchGatewayPath(`${base}/json/version/`)?.kind).toBe(
      "json-version",
    );
    for (const p of ["/json", "/json/", "/json/list", "/json/list/"])
      expect(matchGatewayPath(base + p)?.kind).toBe("json-list");
    expect(matchGatewayPath(`${base}/devtools/browser/8a1-f2`)).toEqual({
      kind: "browser-socket-id",
      sessionId: id,
      id: "8a1-f2",
    });
    expect(matchGatewayPath(`${base}/devtools/page/ABC123`)).toEqual({
      kind: "page-socket",
      sessionId: id,
      targetId: "ABC123",
    });
  });

  it("refuses everything else", () => {
    const base = cdpBasePath(id);
    for (const p of [
      "/",
      "/healthz",
      "/v1/sessions",
      `/v1/sessions/${id}`,
      `${base}/json/new`,
      `${base}/devtools/page/a/b`,
      `${base}/devtools/other/x`,
      `${base}x`,
      "/v1/sessions/ses_bad/cdp",
    ]) {
      expect(matchGatewayPath(p), p).toBeNull();
    }
  });

  it("redacts tokens from anything that will be logged", () => {
    expect(
      redactToken(`/v1/sessions/${id}/cdp?token=secret.jwt.value&x=1`),
    ).toBe(`/v1/sessions/${id}/cdp?token=[redacted]&x=1`);
    expect(redactToken("wss://h:8443/p?a=1&token=abc")).toBe(
      "wss://h:8443/p?a=1&token=[redacted]",
    );
    expect(redactToken("/plain")).toBe("/plain");
  });
});
