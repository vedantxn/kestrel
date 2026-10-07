import { randomBytes } from "node:crypto";
import type { Session } from "@kestrel/contracts";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * P18 (docs/lld/p18-profiles.md section 10): the browser state `bench profiles` writes into a
 * writer session and reads back from a reader, from the harness's own client, on the test page's
 * origin. Every value is random per run, so a value found later (in a reader, or where it must
 * never be, check 7) can only have come from this run. The names stay the same across writes, so
 * a reader that sees some old values and some new ones is a torn profile (check 11).
 */
export interface Marks {
  /** No expiry: Chrome forgets it at exit unless a profile keeps it (over CDP). */
  sessionCookie: { name: string; value: string };
  persistentCookie: { name: string; value: string };
  /** Set over CDP (a page cannot set one); never visible to the page. */
  httpOnlyCookie: { name: string; value: string };
  /** CHIPS: keyed by the top-level site, set by the page with `Partitioned`. */
  partitionedCookie: { name: string; value: string };
  localStorage: { key: string; value: string };
  indexedDb: { db: string; store: string; key: string; value: string };
}

const value = () => `kb${randomBytes(16).toString("hex")}`;

/** Fresh random values under the fixed names. */
export function newMarks(): Marks {
  return {
    sessionCookie: { name: "kb_session", value: value() },
    persistentCookie: { name: "kb_persistent", value: value() },
    httpOnlyCookie: { name: "kb_httponly", value: value() },
    partitionedCookie: { name: "kb_partitioned", value: value() },
    localStorage: { key: "kb_local", value: value() },
    indexedDb: {
      db: "kestrel-bench",
      store: "kv",
      key: "mark",
      value: value(),
    },
  };
}

/** Every random value in a set of marks: what check 7 looks for where it must not be. */
export function markValues(m: Marks): string[] {
  return [
    m.sessionCookie.value,
    m.persistentCookie.value,
    m.httpOnlyCookie.value,
    m.partitionedCookie.value,
    m.localStorage.value,
    m.indexedDb.value,
  ];
}

/** What a reader found, as its client (CDP, for every cookie) and its page see it. */
export interface Readback {
  cookies: {
    name: string;
    value: string;
    httpOnly: boolean;
    session: boolean;
    partitioned: boolean;
  }[];
  /** `document.cookie` on the test page. */
  documentCookie: string;
  localStorage: string | null;
  indexedDb: string | null;
}

export interface MarkCheck {
  item: string;
  ok: boolean;
  detail: string;
}

/**
 * Does a reader hold exactly these marks? Each cookie by name and value and its kind (session,
 * persistent, HttpOnly and hidden from the page, partitioned); web storage by value. The
 * partitioned cookie is judged only if the writer could set one.
 */
export function compareMarks(
  m: Marks,
  r: Readback,
  opts: { partitioned: boolean },
): { ok: boolean; items: MarkCheck[] } {
  const items: MarkCheck[] = [];
  const pageSees = (name: string, v: string) =>
    r.documentCookie.split(/;\s*/).includes(`${name}=${v}`);
  const cookie = (
    item: string,
    c: { name: string; value: string },
    kind: (x: Readback["cookies"][number]) => string | null,
    visible: boolean,
  ) => {
    const found = r.cookies.filter((x) => x.name === c.name);
    const x = found.find((y) => y.value === c.value);
    let problem = !found.length
      ? "missing"
      : !x
        ? "a different value"
        : kind(x);
    if (!problem && visible !== pageSees(c.name, c.value))
      problem = visible
        ? "not visible to the page"
        : "visible to the page (document.cookie)";
    items.push({
      item,
      ok: problem === null,
      detail: problem ?? "present",
    });
  };
  cookie(
    "session cookie",
    m.sessionCookie,
    (x) => (x.session ? null : "kept with an expiry"),
    true,
  );
  cookie(
    "persistent cookie",
    m.persistentCookie,
    (x) => (x.session ? "became a session cookie" : null),
    true,
  );
  cookie(
    "HttpOnly cookie",
    m.httpOnlyCookie,
    (x) =>
      !x.httpOnly ? "lost HttpOnly" : x.session ? "lost its expiry" : null,
    false,
  );
  if (opts.partitioned)
    cookie(
      "partitioned cookie",
      m.partitionedCookie,
      (x) => (x.partitioned ? null : "lost its partition key"),
      true,
    );
  const stored = (item: string, want: string, got: string | null) =>
    items.push({
      item,
      ok: got === want,
      detail:
        got === want
          ? "present"
          : got === null
            ? "missing"
            : "a different value",
    });
  stored("localStorage", m.localStorage.value, r.localStorage);
  stored("IndexedDB", m.indexedDb.value, r.indexedDb);
  return { ok: items.every((i) => i.ok), items };
}

/**
 * Check 11: after a fault during a save, a profile is either the old version or the new one,
 * never some of each. `old` is what the previous version held, `next` what the interrupted
 * writer wrote.
 */
export function classifyMarks(
  old: Marks,
  next: Marks,
  r: Readback,
  opts: { partitioned: boolean },
): { state: "old" | "new" | "torn"; detail: string } {
  const a = compareMarks(old, r, opts);
  if (a.ok) return { state: "old", detail: "every item is the old version's" };
  const b = compareMarks(next, r, opts);
  if (b.ok) return { state: "new", detail: "every item is the new version's" };
  const which = a.items.map((x, i) => {
    const y = b.items[i]!;
    return `${x.item}: ${x.ok ? "old" : y.ok ? "new" : `neither (${y.detail})`}`;
  });
  return { state: "torn", detail: which.join(", ") };
}

// --- in a browser -------------------------------------------------------------------------------

/** A session's browser, through its default context (the one a profile keeps), on the test page. */
export interface Opened {
  session: Session;
  browser: Browser;
  page: Page;
}

export async function openOn(
  session: Session,
  testPageUrl: string,
): Promise<Opened> {
  const browser = await chromium.connectOverCDP(session.connectUrl as string, {
    timeout: 30_000,
  });
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(testPageUrl, { timeout: 30_000 });
    return { session, browser, page };
  } catch (e) {
    await browser.close().catch(() => undefined);
    throw e;
  }
}

const idbPut = (
  db: string,
  store: string,
  entries: string,
) => `new Promise((resolve, reject) => {
  const open = indexedDB.open(${JSON.stringify(db)}, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(${JSON.stringify(store)});
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction(${JSON.stringify(store)}, "readwrite");
    const s = tx.objectStore(${JSON.stringify(store)});
    ${entries}
    tx.oncomplete = () => { open.result.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  };
})`;

/**
 * Write the marks on the page's origin. The page sets its own cookies (session, persistent,
 * partitioned), `localStorage` and an IndexedDB record; the HttpOnly cookie is set over CDP on the
 * browser target (`Storage.setCookies`, no page domain enabled), since a page cannot set one.
 * Says whether Chrome kept the partitioned cookie as partitioned.
 */
export async function writeMarks(
  o: Opened,
  m: Marks,
): Promise<{ partitioned: boolean }> {
  const origin = new URL(o.page.url()).origin;
  const c = (x: { name: string; value: string }, attrs: string) =>
    `document.cookie = ${JSON.stringify(`${x.name}=${x.value}; Path=/; Secure; ${attrs}`)};`;
  await o.page.evaluate(`(async () => {
    ${c(m.sessionCookie, "SameSite=Lax")}
    ${c(m.persistentCookie, "SameSite=Lax; Max-Age=86400")}
    ${c(m.partitionedCookie, "SameSite=None; Partitioned; Max-Age=86400")}
    localStorage.setItem(${JSON.stringify(m.localStorage.key)}, ${JSON.stringify(m.localStorage.value)});
    await ${idbPut(m.indexedDb.db, m.indexedDb.store, `s.put(${JSON.stringify(m.indexedDb.value)}, ${JSON.stringify(m.indexedDb.key)});`)};
  })()`);
  const b = await o.browser.newBrowserCDPSession();
  try {
    await b.send("Storage.setCookies", {
      cookies: [
        {
          name: m.httpOnlyCookie.name,
          value: m.httpOnlyCookie.value,
          url: `${origin}/`,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
    });
  } finally {
    await b.detach().catch(() => undefined);
  }
  const r = await readMarks(o, m);
  return {
    partitioned: r.cookies.some(
      (x) => x.name === m.partitionedCookie.name && x.partitioned,
    ),
  };
}

/** Read back what the marks' names hold, from the client's side and the page's. */
export async function readMarks(o: Opened, m: Marks): Promise<Readback> {
  const b = await o.browser.newBrowserCDPSession();
  let cookies: Readback["cookies"];
  try {
    const got = (await b.send("Storage.getCookies")) as {
      cookies: {
        name: string;
        value: string;
        httpOnly: boolean;
        session: boolean;
        partitionKey?: unknown;
      }[];
    };
    cookies = got.cookies
      .filter((c) => c.name.startsWith("kb_"))
      .map((c) => ({
        name: c.name,
        value: c.value,
        httpOnly: c.httpOnly,
        session: c.session,
        partitioned: c.partitionKey !== undefined && c.partitionKey !== null,
      }));
  } finally {
    await b.detach().catch(() => undefined);
  }
  const page = (await o.page.evaluate(`(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    let idb = null;
    if (dbs.some((d) => d.name === ${JSON.stringify(m.indexedDb.db)}))
      idb = await new Promise((resolve) => {
        const open = indexedDB.open(${JSON.stringify(m.indexedDb.db)});
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(${JSON.stringify(m.indexedDb.store)})) { db.close(); return resolve(null); }
          const get = db.transaction(${JSON.stringify(m.indexedDb.store)}).objectStore(${JSON.stringify(m.indexedDb.store)}).get(${JSON.stringify(m.indexedDb.key)});
          get.onsuccess = () => { db.close(); resolve(typeof get.result === "string" ? get.result : null); };
          get.onerror = () => { db.close(); resolve(null); };
        };
      });
    return {
      documentCookie: document.cookie,
      localStorage: localStorage.getItem(${JSON.stringify(m.localStorage.key)}),
      indexedDb: idb,
    };
  })()`)) as Omit<Readback, "cookies">;
  return { cookies, ...page };
}

/**
 * Store `mib` MiB of random bytes in IndexedDB, 1 MiB per record, made in the page (nothing
 * crosses CDP but the count). Random, so neither Chrome nor the archive's gzip makes it smaller.
 */
export async function fillIndexedDb(page: Page, mib: number): Promise<void> {
  for (let done = 0; done < mib; done += 8) {
    const n = Math.min(8, mib - done);
    await page.evaluate(
      idbPut(
        "kestrel-bench-fill",
        "blobs",
        `for (let i = 0; i < ${n}; i++) {
          const a = new Uint8Array(1 << 20);
          for (let o = 0; o < a.length; o += 65536) crypto.getRandomValues(a.subarray(o, o + 65536));
          s.put(a, ${done} + i);
        }`,
      ),
    );
  }
}
