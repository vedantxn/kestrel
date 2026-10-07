// P18-0 spikes S1-S3 (docs/lld/p18-profiles.md), against a local Chrome for Testing:
//
//   node runtime/experiments/p18/spike.mjs "/path/to/Google Chrome for Testing"
//
// S1: which files a first Chrome writes for cookies, localStorage and IndexedDB.
// S2: Storage.getCookies / Storage.setCookies round trip of session, HttpOnly, SameSite and
//     partitioned cookies.
// S3: a second Chrome, launched on only the allowlisted files (no Local State, no Preferences),
//     opens without an error page and sees everything the first one stored.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import WebSocket from "ws";

const CHROME = process.argv[2];
if (!CHROME) throw new Error("usage: spike.mjs <chrome>");
// Directory prefixes end in "/"; anything else names one file (and its SQLite journal or WAL).
const ALLOW = [
  "Default/Local Storage/leveldb/",
  "Default/LocalStorage",
  "Default/IndexedDB/",
  "Default/WebStorage/",
].filter((p) => !process.env.SPIKE_DROP?.split(",").includes(p));
const allowed = (path) =>
  ALLOW.some((p) =>
    p.endsWith("/")
      ? path.startsWith(p)
      : path === p || path === `${p}-journal` || path === `${p}-wal`,
  );
const DENY = new Set(["LOCK", "LOG", "LOG.old"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The test site. 127.0.0.1 is the top-level site; localhost is a second site embedded in it.
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/write") {
    res.setHeader("set-cookie", [
      "sess=s1; Path=/",
      "hard=h1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
      "lax=l1; Path=/; SameSite=Lax; Max-Age=86400",
    ]);
    return res.end(`<script>
      localStorage.setItem("ls", "v1");
      const r = indexedDB.open("db", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("s");
      r.onsuccess = () => {
        const tx = r.result.transaction("s", "readwrite");
        tx.objectStore("s").put("idb1", "k");
        tx.oncomplete = () => (window.done = true);
      };
    </script><iframe src="http://localhost:${port}/frame"></iframe>`);
  }
  if (url.pathname === "/frame") {
    res.setHeader(
      "set-cookie",
      "part=p1; Path=/; Secure; SameSite=None; Partitioned; Max-Age=86400",
    );
    return res.end("frame");
  }
  if (url.pathname === "/read") {
    return res.end(`<script>
      window.serverCookies = ${JSON.stringify(req.headers.cookie ?? "")};
      window.ls = localStorage.getItem("ls");
      const r = indexedDB.open("db", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("s");
      r.onsuccess = () => {
        const g = r.result.transaction("s").objectStore("s").get("k");
        g.onsuccess = () => (window.idb = g.result ?? null);
      };
    </script>`);
  }
  res.end("");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const port = site.address().port;

async function launch(dir) {
  const debugPort = 20_000 + Math.floor(Math.random() * 1000);
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const t0 = performance.now();
  let v;
  for (;;) {
    try {
      v = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      ).json();
      break;
    } catch {
      if (performance.now() - t0 > 15_000) throw new Error("no Chrome");
      await sleep(100);
    }
  }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  let id = 0;
  const waiting = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id && waiting.has(m.id)) {
      const [r, j] = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) j(new Error(`${m.error.message}`));
      else r(m.result);
    }
  });
  ws.on("error", () => {});
  const send = (method, params = {}, sessionId) =>
    new Promise((r, j) => {
      const i = ++id;
      waiting.set(i, [r, j]);
      ws.send(
        JSON.stringify({
          id: i,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const exited = new Promise((r) => proc.once("exit", r));
  return {
    proc,
    send,
    product: v.Browser,
    launchMs: Math.round(performance.now() - t0),
    exited,
  };
}

async function page(b, url) {
  const { targetId } = await b.send("Target.createTarget", { url });
  const { sessionId } = await b.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const ev = async (expression) =>
    (
      await b.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
      )
    ).result.value;
  return { ev, targetId };
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(100);
  }
}

function walk(root, rel = "", out = []) {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    const st = lstatSync(join(root, p));
    if (st.isDirectory()) walk(root, p, out);
    else out.push({ path: p, bytes: st.size, link: st.isSymbolicLink() });
  }
  return out;
}

// --- First Chrome: write ------------------------------------------------------------------
const a = mkdtempSync(join(tmpdir(), "p18-a-"));
const one = await launch(a);
console.log(`chrome: ${one.product}, launch ${one.launchMs} ms`);
const w = await page(one, `http://127.0.0.1:${port}/write`);
await until(() => w.ev("window.done === true"));
await sleep(500); // the frame's cookie
// S2: also set a partitioned cookie over CDP, in case the header form was refused on http.
await one.send("Storage.setCookies", {
  cookies: [
    {
      name: "cdppart",
      value: "c1",
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "None",
      expires: Math.floor(Date.now() / 1000) + 86400,
      partitionKey: {
        topLevelSite: "http://127.0.0.1",
        hasCrossSiteAncestor: false,
      },
    },
  ],
});
const { cookies } = await one.send("Storage.getCookies");
console.log("\nS2 cookies read over CDP:");
for (const c of cookies)
  console.log(
    `  ${c.name} domain=${c.domain} session=${c.session} httpOnly=${c.httpOnly} sameSite=${c.sameSite ?? "-"} partitionKey=${JSON.stringify(c.partitionKey ?? null)} sourceScheme=${c.sourceScheme}`,
  );
const tClose = performance.now();
await one.send("Browser.close").catch(() => {});
await one.exited;
console.log(
  `\nBrowser.close to exit: ${Math.round(performance.now() - tClose)} ms`,
);

// --- S1: what it wrote ------------------------------------------------------------------------
const files = walk(a);
console.log(`\nS1: ${files.length} files under the user data dir`);
for (const f of files.filter(
  (f) => /Storage|IndexedDB|WebStorage|Cookies/.test(f.path) || f.link,
))
  console.log(`  ${f.path} ${f.bytes}${f.link ? " (link)" : ""}`);
const kept = files.filter(
  (f) => !f.link && allowed(f.path) && !DENY.has(f.path.split("/").at(-1)),
);
console.log(
  `allowlisted: ${kept.length} files, ${kept.reduce((n, f) => n + f.bytes, 0)} bytes`,
);
const other = files
  .filter((f) => f.path.startsWith("Default/") && !kept.includes(f))
  .map((f) => f.path.split("/").slice(0, 2).join("/"));
console.log(`not kept under Default/: ${[...new Set(other)].join(", ")}`);

// --- Second Chrome: only the allowlist, no Local State or Preferences ------------------------
const b = mkdtempSync(join(tmpdir(), "p18-b-"));
for (const f of kept) {
  mkdirSync(dirname(join(b, f.path)), { recursive: true });
  cpSync(join(a, f.path), join(b, f.path));
}
const two = await launch(b);
const setable = cookies.map((c) => {
  const p = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    priority: c.priority,
    sourceScheme: c.sourceScheme,
    sourcePort: c.sourcePort,
  };
  if (!c.session) p.expires = c.expires;
  if (c.partitionKey) p.partitionKey = c.partitionKey;
  return p;
});
await two.send("Storage.setCookies", { cookies: setable });
const back = (await two.send("Storage.getCookies")).cookies;
const r = await page(two, `http://127.0.0.1:${port}/read`);
await until(() => r.ev("window.idb !== undefined"));
const got = await r.ev(
  "JSON.stringify({server: window.serverCookies, js: document.cookie, ls: window.ls, idb: window.idb, url: location.href, title: document.title})",
);
console.log(`\nS3: second Chrome launch ${two.launchMs} ms; page read ${got}`);
console.log(
  `S2: cookies after setCookies: ${back.map((c) => `${c.name}${c.session ? "(session)" : ""}${c.partitionKey ? "(partitioned)" : ""}`).join(", ")}`,
);
const same = (x) =>
  JSON.stringify({ ...x, expires: x.session ? -1 : Math.round(x.expires) });
const lost = cookies.filter((c) => !back.some((d) => same(d) === same(c)));
console.log(
  `S2: cookies differing after the round trip: ${lost.length === 0 ? "none" : lost.map((c) => c.name).join(", ")}`,
);
await two.send("Browser.close").catch(() => {});
await two.exited;
const after = walk(b).filter(
  (f) => f.path === "Local State" || f.path === "Default/Preferences",
);
console.log(`S3: files Chrome remade: ${after.map((f) => f.path).join(", ")}`);
site.close();
process.exit(0);
