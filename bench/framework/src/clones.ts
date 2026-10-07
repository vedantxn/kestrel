import { createHash } from "node:crypto";
import type { Session } from "@kestrel/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import type { KestrelClient } from "./client.js";
import type { HostConfig } from "./collect.js";
import { nodeRuntimes, sessionsOn } from "./placement.js";

/**
 * Threat model T-40, G-24: what a snapshot copies into every clone. Two sessions restored from
 * the same template are observed side by side, the way the session's own client can see them and
 * the way a web page can: randomness in the session's first page and in a page it loads, the
 * clock, media device ids, storage, whether the first connection was a copied one, Chrome's own
 * ids over CDP, and every file in the profile directory (JSON values compared one by one, other
 * files by digest). When the deployment also has a Docker node, two of its sessions are observed
 * the same way as a baseline: a value the same in both clones but different in two containers is
 * one the snapshot copied, because each container's Chrome made its own.
 *
 * Fails on anything that would let one session learn about another or let a site tell that two
 * sessions are clones of one template; what is expected to be the same in every clone is listed
 * with the reason (`CLONE_ALLOWED`).
 */
export interface CloneObservation {
  node: string;
  sessionId: string;
  /** The session's first page, before it loads anything (the page made at rekey). */
  first: { math: number[]; grv: string; uuid: string };
  /** The test page, loaded by the session. */
  page: {
    math: number[];
    grv: string;
    uuid: string;
    /** The page's Date.now() minus the harness's, at the middle of the call. */
    skewMs: number;
    devices: string[];
    cookie: string;
    localStorage: number;
    caches: string[];
    indexedDb: string[];
    serviceWorkers: number;
    constants: Record<string, string | number>;
  };
  /** Was the first navigation sent on a connection that already existed? */
  connectionReused: boolean | null;
  cdp: {
    cookies: number;
    browserContextIds: string[];
    browserPid: number | null;
  };
  /** Every file under the profile directory: its size and a digest of what it holds. */
  files: Record<string, { size: number; digest: string | null }>;
  /** JSON files' values, flattened: `<file>#<key.path>` to a printable value. */
  json: Record<string, string>;
}

export interface CloneItem {
  item: string;
  verdict: "unique" | "same-everywhere" | "copied" | "allowed" | "fail";
  why: string;
}

export interface CloneDiff {
  pass: boolean;
  baseline: boolean;
  failures: CloneItem[];
  /** Everything the same in both clones, with what was concluded about it. */
  shared: CloneItem[];
  uniqueCount: number;
}

/** Expected to be the same in every clone, and why that is harmless. */
export const CLONE_ALLOWED: { pattern: RegExp; why: string }[] = [
  {
    pattern: /^cdp\.(browserContextIds|browserPid)$/,
    why: "Chrome's own process id and default context id: seen only by the session's own CDP client, never by a page, and meaningless outside its browser",
  },
  {
    pattern: /#protection\.(macs\.|super_mac|super_encrypted_hash$)/,
    why: "HMACs Chrome keeps to detect tampering with preference values: derived from the values themselves, not exposed to pages, and no secret between sessions",
  },
  {
    // Found by the first host run, 2026-10-07; accepted rather than reset, since a new value needs a
    // new Chrome in every clone (threat model 9.1). The owner may decide otherwise.
    pattern:
      /^Local State#(user_experience_metrics\.(low_entropy_source3|pseudo_low_entropy_source|limited_entropy_randomization_source)|autofill\.ablation_seed)$/,
    why: "Field-trial randomization made at Chrome's first run: it only picks groups within field trials, and Kestrel's Chrome has none (background networking is off, so no variations seed is fetched, and Local State holds no variations_* key). Never exposed to pages",
  },
  {
    pattern:
      /^Default\/Preferences#(google\.services\.signin_scoped_device_id|enterprise_profile_guid)$/,
    why: "Ids Chrome sends only to Google's sign-in service and to enterprise cloud management: Kestrel's Chrome never signs in, syncs or is managed, and background networking is off. Never exposed to pages",
  },
  {
    pattern:
      /^Default\/Preferences#extensions\.settings\.[a-p]{32}\.first_install_time$/,
    why: "When Chrome's built-in component extensions were installed: the template's build time, not exposed to pages",
  },
  {
    pattern:
      /^file:Default\/(Extension Rules|Extension Scripts|Extension State|Service Worker\/Database|shared_proto_db|shared_proto_db\/metadata|Site Characteristics Database|Sync Data\/LevelDB)\/(LOG|\d{6}\.log)$/,
    why: "LevelDB's own text log and write-ahead log of databases Chrome made empty at template build: timestamps and bookkeeping, no page data (the case checks that storage and service workers are empty in a new session)",
  },
  {
    pattern: /^Local State#uninstall_metrics\.installation_date2$/,
    why: "Chrome's install time, kept for uninstall metrics: not exposed to pages, and the template's age is no secret between sessions",
  },
];

/** Names that hold secrets or identifiers: copied, they link clones. */
const SENSITIVE_KEY =
  /(salt|seed|secret|token|nonce|entropy|random|hmac|guid|uuid|client_?id|machine_?id|device_?id|install|_id2?$|\bid$|key)/i;
/** Profile files that hold per-profile secrets in binary form. */
const SENSITIVE_FILE =
  /(^|\/)(Visited Links|MediaDeviceSalts|Trust Tokens|BrowsingTopicsState|BrowsingTopicsSiteData|Cookies|Network Persistent State|TransportSecurity|Reporting and NEL|Local State|Preferences|Secure Preferences)$/;

/** A string that looks generated rather than written. */
export function looksRandom(v: string): boolean {
  if (v.length < 16 || /^\d+$/.test(v) || /\s/.test(v)) return false;
  if (/^[0-9a-f-]{16,}$/i.test(v) && /[a-f]/i.test(v) && /\d/.test(v))
    return true;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length;
  return classes >= 3;
}

/** Flatten JSON into `prefix#a.b.c` leaves, printable and bounded. */
export function flatten(
  prefix: string,
  v: unknown,
  out: Record<string, string> = {},
  path = "",
): Record<string, string> {
  if (Object.keys(out).length > 5000) return out;
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      flatten(prefix, x, out, path ? `${path}.${k}` : k);
  } else out[`${prefix}#${path}`] = String(v).slice(0, 200);
  return out;
}

export function compareClones(
  a: CloneObservation,
  b: CloneObservation,
  baseline?: [CloneObservation, CloneObservation],
): CloneDiff {
  const shared: CloneItem[] = [];
  const failures: CloneItem[] = [];
  let uniqueCount = 0;
  const fail = (item: string, why: string) =>
    void failures.push({ item, verdict: "fail", why });

  // 1. Randomness a page can read: never the same in two clones.
  for (const where of ["first", "page"] as const) {
    const x = a[where];
    const y = b[where];
    if (x.math.some((m) => y.math.includes(m)))
      fail(
        `${where}.Math.random`,
        "Math.random gave the same value in two clones: they share a renderer's random state",
      );
    else uniqueCount++;
    for (const k of ["grv", "uuid"] as const)
      // randomUUID exists only in a secure context, so the first page (about:blank) has none: an
      // empty value is not a shared one. The first page's crypto is still compared through grv.
      if (!x[k] || !y[k]) continue;
      else if (x[k] === y[k])
        fail(`${where}.${k}`, `crypto's ${k} is the same in two clones`);
      else uniqueCount++;
  }
  // 2. The clock: a clone's clock is the template's plus the time since, unless it is corrected.
  for (const o of [a, b])
    if (Math.abs(o.page.skewMs) > 2000)
      fail(
        `clock.${o.sessionId}`,
        `the page's clock is ${Math.round(o.page.skewMs / 1000)} s off the host's: every clone of one template shares the offset, which marks them as one browser`,
      );
  // 3. Media device ids: per-origin ids derived from a salt; the same in two clones means a shared salt.
  const shownDevices = a.page.devices.filter((d) => d !== "");
  if (shownDevices.some((d) => b.page.devices.includes(d)))
    fail(
      "page.mediaDevices",
      "enumerateDevices() gave the same device id in two clones",
    );
  // 4. Nothing stored, and no connection kept, from the template.
  for (const o of [a, b]) {
    const p = o.page;
    const stored = [
      p.cookie && "cookies",
      p.localStorage && "local storage",
      p.caches.length && "Cache Storage",
      p.indexedDb.length && "IndexedDB",
      p.serviceWorkers && "service workers",
      o.cdp.cookies && "cookies in the browser",
    ].filter(Boolean);
    if (stored.length)
      fail(
        `storage.${o.sessionId}`,
        `a new session already has ${stored.join(", ")}`,
      );
    if (o.connectionReused === true)
      fail(
        `connection.${o.sessionId}`,
        "the session's first request went over a connection that existed before it",
      );
  }

  // 5. Everything else: the same in both clones is either the same everywhere, or copied.
  const differsInBaseline = (get: (o: CloneObservation) => unknown) =>
    baseline ? get(baseline[0]) !== get(baseline[1]) : null;
  const judgeShared = (
    item: string,
    value: string,
    get: (o: CloneObservation) => unknown,
    sensitive: boolean,
  ) => {
    const allowed = CLONE_ALLOWED.find((x) => x.pattern.test(item));
    const inBaseline = differsInBaseline(get);
    if (inBaseline === false) {
      shared.push({
        item,
        verdict: "same-everywhere",
        why: "the same in two containers too: part of the build, not the snapshot",
      });
      return;
    }
    if (allowed) {
      shared.push({ item, verdict: "allowed", why: allowed.why });
      return;
    }
    const copied = inBaseline === true || looksRandom(value);
    if (copied && (sensitive || looksRandom(value)))
      fail(
        item,
        inBaseline
          ? "copied into every clone by the snapshot (two containers differ), and it is an identifier or a secret"
          : "the same generated value in both clones",
      );
    else
      shared.push({
        item,
        verdict: copied ? "copied" : "same-everywhere",
        why: copied
          ? "copied by the snapshot; not an identifier or a secret"
          : "no evidence it was generated",
      });
  };

  judgeShared(
    "cdp.browserContextIds",
    a.cdp.browserContextIds.join(","),
    (o) => o.cdp.browserContextIds.join(","),
    true,
  );
  if (a.cdp.browserPid !== null && a.cdp.browserPid === b.cdp.browserPid)
    judgeShared(
      "cdp.browserPid",
      String(a.cdp.browserPid),
      (o) => o.cdp.browserPid,
      false,
    );
  for (const [k, v] of Object.entries(a.json)) {
    if (b.json[k] !== v) {
      uniqueCount++;
      continue;
    }
    const key =
      k
        .slice(k.indexOf("#") + 1)
        .split(".")
        .pop() ?? "";
    judgeShared(k, v, (o) => o.json[k], SENSITIVE_KEY.test(key));
  }
  for (const [f, x] of Object.entries(a.files)) {
    const y = b.files[f];
    if (!y || x.digest === null || x.digest !== y.digest) {
      uniqueCount++;
      continue;
    }
    if (Object.keys(a.json).some((k) => k.startsWith(`${f}#`))) continue; // judged value by value
    judgeShared(
      `file:${f}`,
      x.digest,
      (o) => o.files[f]?.digest,
      SENSITIVE_FILE.test(f),
    );
  }
  return {
    pass: failures.length === 0,
    baseline: Boolean(baseline),
    failures,
    shared,
    uniqueCount,
  };
}

// --- observing a session ------------------------------------------------------------------------

const RANDOM = `(() => ({
  math: [Math.random(), Math.random(), Math.random()],
  grv: Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join(""),
  uuid: crypto.randomUUID ? crypto.randomUUID() : "",
}))()`;

const PAGE = `(async () => {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  const caches_ = await (self.caches ? caches.keys() : Promise.resolve([])).catch(() => []);
  const idb = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([])).catch(() => []);
  const sw = await (navigator.serviceWorker ? navigator.serviceWorker.getRegistrations() : Promise.resolve([])).catch(() => []);
  return {
    now: Date.now(),
    devices: devices.flatMap((d) => [d.deviceId, d.groupId]),
    cookie: document.cookie,
    localStorage: (() => { try { return localStorage.length; } catch { return 0; } })(),
    caches: caches_,
    indexedDb: idb.map((d) => d.name),
    serviceWorkers: sw.length,
    constants: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? 0,
      screen: screen.width + "x" + screen.height,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: navigator.languages.join(","),
    },
  };
})()`;

/** Parse Chrome's file:// directory listing (its addRow(name, url, isdir, size, ...) calls). */
export function parseListing(
  html: string,
): { name: string; dir: boolean; size: number }[] {
  const out: { name: string; dir: boolean; size: number }[] = [];
  const re = /addRow\("((?:[^"\\]|\\.)*)","(?:[^"\\]|\\.)*",(\d),(\d+),/g;
  for (const m of html.matchAll(re)) {
    const name = JSON.parse(`"${m[1]}"`) as string;
    if (name === ".." || name === ".") continue;
    out.push({ name, dir: m[2] === "1", size: Number(m[3]) });
  }
  return out;
}

const TEXT_FILES =
  /(^|\/)(Local State|Preferences|Secure Preferences|Network Persistent State|TransportSecurity|BrowsingTopicsState|Last Version|Last Browser|First Run|Variations)$/;

async function readProfile(
  browser: Browser,
): Promise<Pick<CloneObservation, "files" | "json">> {
  // A context of its own: reading files must not write to the session's history or caches.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const files: CloneObservation["files"] = {};
  const json: CloneObservation["json"] = {};
  const text = async (url: string): Promise<string | null> => {
    try {
      await page.goto(url, { timeout: 10_000 });
      return await page.evaluate(
        "document.body ? document.body.innerText : ''",
      );
    } catch {
      return null; // a download, or a file Chrome will not show
    }
  };
  try {
    const queue = [""];
    let seen = 0;
    while (queue.length && seen < 400) {
      const dir = queue.shift()!;
      try {
        await page.goto(`file:///profile/${encodeURI(dir)}`, {
          timeout: 10_000,
        });
      } catch {
        continue;
      }
      for (const e of parseListing(await page.content())) {
        seen++;
        const path = `${dir}${e.name}`;
        if (e.dir) {
          if (path.split("/").length <= 4) queue.push(`${path}/`);
          continue;
        }
        let digest: string | null = null;
        if (e.size <= 4 * 1024 * 1024) {
          const isText = TEXT_FILES.test(path);
          const t = await text(
            isText
              ? `file:///profile/${encodeURI(path)}`
              : `view-source:file:///profile/${encodeURI(path)}`,
          );
          if (t !== null) {
            digest = createHash("sha256").update(t).digest("hex").slice(0, 16);
            if (isText)
              try {
                flatten(path, JSON.parse(t), json);
              } catch {
                json[`${path}#`] = t.slice(0, 200);
              }
          }
        }
        files[path] = { size: e.size, digest };
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  return { files, json };
}

/** Observe one session (G-24): see `CloneObservation`. */
export async function observe(
  session: Session,
  testPageUrl: string,
): Promise<CloneObservation> {
  const browser = await chromium.connectOverCDP(session.connectUrl as string, {
    timeout: 30_000,
  });
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
    const first = (await page.evaluate(RANDOM)) as CloneObservation["first"];
    const cdp = await ctx.newCDPSession(page);
    let connectionReused: boolean | null = null;
    await cdp.send("Network.enable");
    cdp.on("Network.responseReceived", (e) => {
      if (connectionReused === null && e.type === "Document")
        connectionReused = e.response.connectionReused;
    });
    await page.goto(testPageUrl, { timeout: 30_000 });
    await cdp.detach().catch(() => undefined);
    const random = (await page.evaluate(RANDOM)) as CloneObservation["first"];
    const t0 = Date.now();
    const p = (await page.evaluate(PAGE)) as Omit<
      CloneObservation["page"],
      "math" | "grv" | "uuid" | "skewMs"
    > & { now: number };
    const t1 = Date.now();
    const b = await browser.newBrowserCDPSession();
    await b
      .send("Browser.setDownloadBehavior", { behavior: "deny" })
      .catch(() => undefined);
    const targets = (await b.send("Target.getTargets")).targetInfos;
    const procs = (await b
      .send("SystemInfo.getProcessInfo")
      .catch(() => ({ processInfo: [] }))) as {
      processInfo: { type: string; id: number }[];
    };
    const cookies = (await b
      .send("Storage.getCookies")
      .catch(() => ({ cookies: [] }))) as { cookies: unknown[] };
    const profile = await readProfile(browser);
    return {
      node: session.nodeId ?? "?",
      sessionId: session.id,
      first,
      page: {
        ...random,
        skewMs: p.now - (t0 + t1) / 2,
        devices: p.devices,
        cookie: p.cookie,
        localStorage: p.localStorage,
        caches: p.caches,
        indexedDb: p.indexedDb,
        serviceWorkers: p.serviceWorkers,
        constants: p.constants,
      },
      connectionReused,
      cdp: {
        cookies: cookies.cookies.length,
        browserContextIds: [
          ...new Set(
            targets
              .map((t) => t.browserContextId)
              .filter((x): x is string => Boolean(x)),
          ),
        ].sort(),
        browserPid:
          procs.processInfo.find((x) => x.type === "browser")?.id ?? null,
      },
      ...profile,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function observePair(
  client: KestrelClient,
  node: string,
  testPageUrl: string,
): Promise<[CloneObservation, CloneObservation]> {
  const sessions = await sessionsOn(client, node, 2);
  try {
    return [
      await observe(sessions[0]!, testPageUrl),
      await observe(sessions[1]!, testPageUrl),
    ];
  } finally {
    for (const s of sessions) await client.stop(s.id).catch(() => undefined);
  }
}

/** The G-24 case: two clones on a microVM node, and two containers as a baseline if there are any. */
export async function runCloneDiff(
  client: KestrelClient,
  host: HostConfig,
  testPageUrl: string,
): Promise<(CloneDiff & { node: string }) | { skipped: string }> {
  const runtimes = await nodeRuntimes(host);
  const vmNode = [...runtimes].find(([, r]) => r === "microvm")?.[0];
  if (!vmNode) return { skipped: "no microVM node in this deployment" };
  const dockerNode = [...runtimes].find(([, r]) => r === "docker")?.[0];
  const [a, b] = await observePair(client, vmNode, testPageUrl);
  const baseline = dockerNode
    ? await observePair(client, dockerNode, testPageUrl)
    : undefined;
  return { node: vmNode, ...compareClones(a, b, baseline) };
}
