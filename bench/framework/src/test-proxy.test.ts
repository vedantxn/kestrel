import { createServer as createHttp, request } from "node:http";
import {
  connect,
  createServer as createTcp,
  type AddressInfo,
  type Server,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestProxy } from "./test-proxy.js";

const servers: { close(cb: () => void): unknown }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});
const listen = async <T extends Server | ReturnType<typeof createHttp>>(
  s: T,
): Promise<number> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
};
const basic = (u: string, p: string) =>
  "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

function rawConnect(
  port: number,
  target: string,
  auth?: string,
): Promise<{ head: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let buf = "";
    s.on("error", reject);
    s.on("data", function onData(d) {
      buf += d.toString();
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      resolve({ head: buf.slice(0, end), socket: s });
    });
    s.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        (auth ? `Proxy-Authorization: ${auth}\r\n` : "") +
        "\r\n",
    );
  });
}

describe("the test proxy for bench proxy", () => {
  it("requires its credentials, tunnels with them, and never logs them", async () => {
    const echo = createTcp((s) => s.pipe(s));
    const echoPort = await listen(echo);
    const lines: string[] = [];
    const proxy = createTestProxy({
      user: "u",
      password: "pw-secret",
      allowPorts: [echoPort],
      log: (l) => lines.push(l),
    });
    const port = await listen(proxy);
    const target = `127.0.0.1:${echoPort}`;
    const none = await rawConnect(port, target);
    expect(none.head).toMatch(/^HTTP\/1\.1 407/);
    none.socket.destroy();
    const bad = await rawConnect(port, target, basic("u", "nope"));
    expect(bad.head).toMatch(/^HTTP\/1\.1 407/);
    bad.socket.destroy();
    const ok = await rawConnect(port, target, basic("u", "pw-secret"));
    expect(ok.head).toMatch(/^HTTP\/1\.1 200/);
    const echoed = new Promise<string>((r) =>
      ok.socket.once("data", (d) => r(d.toString())),
    );
    ok.socket.write("ping");
    expect(await echoed).toBe("ping");
    ok.socket.destroy();
    const refused = await rawConnect(
      port,
      "127.0.0.1:1",
      basic("u", "pw-secret"),
    );
    expect(refused.head).toMatch(/^HTTP\/1\.1 403/);
    refused.socket.destroy();
    expect(lines.map((l) => JSON.parse(l).auth)).toEqual([
      "none",
      "bad",
      "ok",
      "ok",
    ]);
    expect(JSON.parse(lines[2]!).target).toBe(target);
    expect(lines.join("")).not.toContain("pw-secret");
    expect(lines.join("")).not.toContain(basic("u", "pw-secret").slice(6));
  });

  it("forwards an absolute-URI request without passing on its credentials", async () => {
    let seen: Record<string, unknown> = {};
    const origin = createHttp((req, res) => {
      seen = req.headers;
      res.end(`origin saw ${req.url}`);
    });
    const originPort = await listen(origin);
    const proxy = createTestProxy({
      user: "u",
      password: "pw",
      allowPorts: [originPort],
      log: () => undefined,
    });
    const port = await listen(proxy);
    const body = await new Promise<string>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path: `http://127.0.0.1:${originPort}/x?y=1`,
          headers: { "proxy-authorization": basic("u", "pw") },
        },
        (res) => {
          let t = "";
          res.on("data", (d) => (t += d));
          res.on("end", () => resolve(t));
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(body).toBe("origin saw /x?y=1");
    expect(seen["proxy-authorization"]).toBeUndefined();
  });
});
