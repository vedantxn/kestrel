import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMarks,
  compareMarks,
  fillIndexedDb,
  markValues,
  newMarks,
  openOn,
  readMarks,
  writeMarks,
  type Marks,
  type Readback,
} from "./profile-data.js";

/** What a reader would see of `m` if the profile kept everything. */
function seen(m: Marks): Readback {
  return {
    cookies: [
      {
        ...m.sessionCookie,
        httpOnly: false,
        session: true,
        partitioned: false,
      },
      {
        ...m.persistentCookie,
        httpOnly: false,
        session: false,
        partitioned: false,
      },
      {
        ...m.httpOnlyCookie,
        httpOnly: true,
        session: false,
        partitioned: false,
      },
      {
        ...m.partitionedCookie,
        httpOnly: false,
        session: false,
        partitioned: true,
      },
    ],
    documentCookie: [m.sessionCookie, m.persistentCookie, m.partitionedCookie]
      .map((c) => `${c.name}=${c.value}`)
      .join("; "),
    localStorage: m.localStorage.value,
    indexedDb: m.indexedDb.value,
  };
}
const P = { partitioned: true };
const failed = (m: Marks, r: Readback, opts = P) =>
  compareMarks(m, r, opts)
    .items.filter((i) => !i.ok)
    .map((i) => `${i.item}: ${i.detail}`);

describe("the marks a writer leaves and a reader finds (P18 checks 1-3)", () => {
  it("are random per run, under fixed names", () => {
    const a = newMarks();
    const b = newMarks();
    expect(a.sessionCookie.name).toBe(b.sessionCookie.name);
    expect(new Set([...markValues(a), ...markValues(b)]).size).toBe(12);
  });

  it("passes a reader that holds every item, each of its kind", () => {
    const m = newMarks();
    expect(compareMarks(m, seen(m), P)).toMatchObject({ ok: true });
  });

  it("names each item missing, changed or of the wrong kind, and only that", () => {
    const m = newMarks();
    const cases: [string, (r: Readback) => void, string][] = [
      [
        "session cookie dropped",
        (r) => (r.cookies = r.cookies.filter((c) => c.name !== "kb_session")),
        "session cookie: missing",
      ],
      [
        "session cookie given an expiry",
        (r) => (r.cookies[0]!.session = false),
        "session cookie: kept with an expiry",
      ],
      [
        "persistent cookie with another value",
        (r) => (r.cookies[1]!.value = "other"),
        "persistent cookie: a different value",
      ],
      [
        "HttpOnly lost",
        (r) => (r.cookies[2]!.httpOnly = false),
        "HttpOnly cookie: lost HttpOnly",
      ],
      [
        "HttpOnly cookie seen by the page",
        (r) =>
          (r.documentCookie += `; ${m.httpOnlyCookie.name}=${m.httpOnlyCookie.value}`),
        "HttpOnly cookie: visible to the page (document.cookie)",
      ],
      [
        "a page cookie the page cannot see",
        (r) =>
          (r.documentCookie = r.documentCookie.replace("kb_persistent", "x")),
        "persistent cookie: not visible to the page",
      ],
      [
        "partition key lost",
        (r) => (r.cookies[3]!.partitioned = false),
        "partitioned cookie: lost its partition key",
      ],
      [
        "localStorage gone",
        (r) => (r.localStorage = null),
        "localStorage: missing",
      ],
      [
        "IndexedDB changed",
        (r) => (r.indexedDb = "x"),
        "IndexedDB: a different value",
      ],
    ];
    for (const [name, f, want] of cases) {
      const r = seen(m);
      f(r);
      expect(failed(m, r), name).toEqual([want]);
    }
  });

  it("does not judge the partitioned cookie when the writer could not set one", () => {
    const m = newMarks();
    const r = seen(m);
    r.cookies = r.cookies.filter((c) => c.name !== "kb_partitioned");
    r.documentCookie = r.documentCookie.replace(/; kb_partitioned=[^;]*/, "");
    expect(failed(m, r)).toEqual(["partitioned cookie: missing"]);
    expect(compareMarks(m, r, { partitioned: false }).ok).toBe(true);
  });
});

describe("old, new or torn (P18 check 11)", () => {
  it("is the old version, the new one, or names what is mixed", () => {
    const old = newMarks();
    const next = newMarks();
    expect(classifyMarks(old, next, seen(old), P).state).toBe("old");
    expect(classifyMarks(old, next, seen(next), P).state).toBe("new");
    const mixed = seen(old);
    mixed.localStorage = next.localStorage.value;
    const t = classifyMarks(old, next, mixed, P);
    expect(t.state).toBe("torn");
    expect(t.detail).toContain("localStorage: new");
    expect(t.detail).toContain("session cookie: old");
    const empty: Readback = {
      cookies: [],
      documentCookie: "",
      localStorage: null,
      indexedDb: null,
    };
    expect(classifyMarks(old, next, empty, P).state).toBe("torn");
  });
});

/*
 * Against a real Chrome, when one is named: KESTREL_TEST_CHROME=/path/to/chrome. The page code the
 * harness runs on the host writes every mark and reads it back in the same browser, and a second,
 * empty browser finds none of them.
 */
const CHROME = process.env.KESTREL_TEST_CHROME;
describe.skipIf(!CHROME)("the marks in a real Chrome", () => {
  const procs: ChildProcess[] = [];
  let site: Server | undefined;
  afterEach(async () => {
    for (const p of procs.splice(0)) p.kill("SIGKILL");
    site?.closeAllConnections();
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
    site = undefined;
  });

  async function chrome(): Promise<Session> {
    const port = 22_000 + Math.floor(Math.random() * 1000);
    procs.push(
      spawn(
        CHROME as string,
        [
          "--headless=new",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${mkdtempSync(join(tmpdir(), "marks-"))}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--use-mock-keychain",
          "about:blank",
        ],
        { stdio: "ignore" },
      ),
    );
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        if (Date.now() > end) throw new Error("Chrome did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { connectUrl: `http://127.0.0.1:${port}` } as Session;
  }

  it("writes every mark, reads them back, and an empty browser has none", async () => {
    site = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<title>Kestrel test page</title>");
    });
    await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
    // localhost is a secure context, so Secure and Partitioned cookies are allowed on it.
    const url = `http://localhost:${(site.address() as AddressInfo).port}/`;
    const m = newMarks();
    const a = await openOn(await chrome(), url);
    try {
      const { partitioned } = await writeMarks(a, m);
      expect(partitioned).toBe(true);
      const r = await readMarks(a, m);
      expect(failed(m, r, { partitioned })).toEqual([]);
      await fillIndexedDb(a.page, 3);
      const count = await a.page.evaluate(`new Promise((resolve) => {
        const o = indexedDB.open("kestrel-bench-fill");
        o.onsuccess = () => { const c = o.result.transaction("blobs").objectStore("blobs").count(); c.onsuccess = () => resolve(c.result); };
      })`);
      expect(count).toBe(3);
    } finally {
      await a.browser.close();
    }
    const b = await openOn(await chrome(), url);
    try {
      const r = await readMarks(b, m);
      expect(r).toEqual({
        cookies: [],
        documentCookie: "",
        localStorage: null,
        indexedDb: null,
      });
    } finally {
      await b.browser.close();
    }
  });
});
