import { createServer as createHttp, request } from "node:http";
import {
  connect,
  createServer as createTcp,
  type AddressInfo,
  type Server,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  SELF_HOST,
  createTestProxy,
  createTestSocksProxy,
} from "./test-proxy.js";

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

  it("answers plain HTTP for its own name, and refuses to tunnel to it", async () => {
    const proxy = createTestProxy({
      user: "u",
      password: "pw",
      log: () => undefined,
    });
    const port = await listen(proxy);
    const body = await new Promise<string>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path: `http://${SELF_HOST}/check`,
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
    expect(body).toBe(
      `plain http via the test proxy: GET http://${SELF_HOST}/check`,
    );
    const tunnel = await rawConnect(port, `${SELF_HOST}:443`, basic("u", "pw"));
    expect(tunnel.head).toMatch(/^HTTP\/1\.1 403/);
    tunnel.socket.destroy();
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

/** A SOCKS5 client handshake, then whatever `then` does with the tunnel. */
function socks(
  port: number,
  user: string,
  pass: string,
  host: string,
  targetPort: number,
): Promise<{ reply: number[]; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let step = 0;
    s.on("error", reject);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2) {
        if (buf[1] === 0xff) {
          s.off("data", onData);
          return resolve({ reply: [...buf], socket: s });
        }
        buf = buf.subarray(2);
        step = 1;
        const u = Buffer.from(user);
        const p = Buffer.from(pass);
        s.write(
          Buffer.concat([
            Buffer.from([1, u.length]),
            u,
            Buffer.from([p.length]),
            p,
          ]),
        );
      }
      if (step === 1 && buf.length >= 2) {
        if (buf[1] !== 0) {
          s.off("data", onData);
          return resolve({ reply: [...buf.subarray(0, 2)], socket: s });
        }
        buf = buf.subarray(2);
        step = 2;
        const h = Buffer.from(host);
        const pt = Buffer.alloc(2);
        pt.writeUInt16BE(targetPort);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, pt]));
      }
      if (step === 2 && buf.length >= 10) {
        s.off("data", onData);
        resolve({ reply: [...buf.subarray(0, 10)], socket: s });
      }
    };
    s.on("data", onData);
    s.write(Buffer.from([5, 1, 2]));
  });
}

const readAll = (s: ReturnType<typeof connect>): Promise<string> =>
  new Promise((resolve) => {
    let t = "";
    s.on("data", (d) => (t += d.toString()));
    s.on("close", () => resolve(t));
  });

describe("the test proxy's other modes, for SOCKS5, TLS and adapter checks", () => {
  it("accepts adapter-written credentials and says what it saw at /who", async () => {
    const lines: string[] = [];
    const proxy = createTestProxy({
      user: "k",
      password: "pw-base",
      log: (l) => lines.push(l),
    });
    const port = await listen(proxy);
    const get = (auth: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request(
          {
            host: "127.0.0.1",
            port,
            path: `http://${SELF_HOST}${path}`,
            headers: { "proxy-authorization": auth },
          },
          (res) => {
            let t = "";
            res.on("data", (d) => (t += d));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: t }),
            );
          },
        );
        r.on("error", reject);
        r.end();
      });
    const who = await get(
      basic("user-k-country-de-session-abc", "pw-base_country-de"),
      "/who",
    );
    expect(JSON.parse(who.body)).toEqual({
      via: "http",
      username: "user-k-country-de-session-abc",
      passwordExtra: "_country-de",
    });
    expect((await get(basic("k", "pw-base-x"), "/who")).status).toBe(407);
    expect((await get(basic("someone", "pw-base"), "/who")).status).toBe(407);
    const bytes = await get(basic("k", "pw-base"), "/bytes/200000");
    expect(bytes.body.length).toBe(200_000);
    expect(lines.join("")).not.toContain("pw-base");
  });

  it("speaks SOCKS5: tunnels by name, answers its own name, refuses bad credentials", async () => {
    const echo = createTcp((s) => s.pipe(s));
    const echoPort = await listen(echo);
    const lines: string[] = [];
    const proxy = createTestSocksProxy({
      user: "k",
      password: "pw",
      allowPorts: [80, echoPort],
      log: (l) => lines.push(l),
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as AddressInfo).port;

    const t = await socks(port, "k", "pw", "localhost", echoPort);
    expect(t.reply[1]).toBe(0);
    const echoed = new Promise<string>((r) =>
      t.socket.once("data", (d) => r(d.toString())),
    );
    t.socket.write("ping");
    expect(await echoed).toBe("ping");
    t.socket.destroy();

    const self = await socks(port, "user-k-country-fr", "pw", SELF_HOST, 80);
    expect(self.reply[1]).toBe(0);
    self.socket.write(
      `GET /who HTTP/1.1\r\nHost: ${SELF_HOST}\r\nConnection: close\r\n\r\n`,
    );
    const answer = await readAll(self.socket);
    expect(answer.slice(answer.indexOf("\r\n\r\n") + 4)).toBe(
      JSON.stringify({
        via: "socks5",
        username: "user-k-country-fr",
        passwordExtra: "",
      }),
    );

    const bad = await socks(port, "k", "nope", "localhost", echoPort);
    expect(bad.reply).toEqual([1, 1]);
    bad.socket.destroy();
    expect(
      lines.some((l) => JSON.parse(l).target === `name:localhost:${echoPort}`),
    ).toBe(true);
    expect(lines.join("")).not.toContain('"pw"');
  });

  it("serves HTTPS when given a certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-proxy-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "k.pem",
        "-out",
        "c.pem",
        "-days",
        "1",
        "-subj",
        "/CN=proxy.test",
        "-addext",
        "subjectAltName=DNS:proxy.test",
      ],
      { cwd: dir, stdio: "pipe" },
    );
    const cert = readFileSync(join(dir, "c.pem"), "utf8");
    const proxy = createTestProxy({
      user: "k",
      password: "pw",
      log: () => undefined,
      tls: { cert, key: readFileSync(join(dir, "k.pem"), "utf8") },
    });
    const port = await listen(proxy);
    const body = await new Promise<string>((resolve, reject) => {
      const s = tlsConnect({
        host: "127.0.0.1",
        port,
        servername: "proxy.test",
        ca: [cert],
      });
      s.on("error", reject);
      s.on("secureConnect", () =>
        s.write(
          `GET http://${SELF_HOST}/who HTTP/1.1\r\nHost: ${SELF_HOST}\r\nProxy-Authorization: ${basic("k", "pw")}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let t = "";
      s.on("data", (d) => (t += d.toString()));
      s.on("end", () => resolve(t.slice(t.indexOf("\r\n\r\n") + 4)));
    });
    expect(JSON.parse(body)).toMatchObject({ via: "https", username: "k" });
  });
});
