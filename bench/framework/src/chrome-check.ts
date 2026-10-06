/**
 * Threat model G-15 (HLD 8.5 patch rule): how far the Chrome pinned in `runtime/CHROME_VERSION`
 * is behind Stable, and whether the gap crosses a security release.
 *
 *   node bench/framework/src/chrome-check.ts [--version-file F] [--markdown F] [--json F]
 *   bin/chrome-check                                       (the same, from anywhere)
 *
 * Sources, all public and unauthenticated:
 * - Chrome for Testing, `last-known-good-versions.json` (required): the Stable version it serves,
 *   and `known-good-versions.json`: whether a version is listed. A version's linux64 download is
 *   also checked directly, because the listing can trail Chrome's own release by days while the
 *   build is already downloadable.
 * - Chromium Dash, `fetch_releases` (best effort): Chrome's own Stable releases for Linux.
 * - The Chrome Releases blog feed (best effort): each Stable desktop update and its security
 *   fix count.
 *
 * Everything fetched is untrusted: only version numbers, dates, counts and links on the blog's
 * own domain are taken from it. Exits 0 with a report, behind or not; 1 if Chrome for Testing
 * could not be read. One file with no imports beyond Node's, so Node 24 runs it from source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCES = {
  cftLastKnownGood:
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
  cftKnownGood:
    "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json",
  cftDownload: (v: string) =>
    `https://storage.googleapis.com/chrome-for-testing-public/${v}/linux64/chrome-linux64.zip`,
  chromiumDash:
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=30",
  releaseFeed:
    "https://chromereleases.googleblog.com/feeds/posts/default/-/Desktop%20Update?alt=json&max-results=50",
};

/** HLD 8.5: rebuilt and rolled out within seven days of a Stable security release. */
export const PATCH_DAYS = 7;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6}$/;
const BLOG = /^https:\/\/chromereleases\.googleblog\.com\/[A-Za-z0-9/_.-]+$/;

export function isVersion(v: unknown): v is string {
  return typeof v === "string" && VERSION.test(v);
}

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const milestone = (v: string): number => Number(v.split(".")[0]);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** `last-known-good-versions.json`: the Stable channel's version. */
export function parseCftStable(json: unknown): string {
  const v = obj(obj(obj(json).channels).Stable).version;
  if (!isVersion(v))
    throw new Error("Chrome for Testing: no Stable version in the answer");
  return v;
}

/** `known-good-versions.json`: every version Chrome for Testing lists. */
export function parseCftKnownGood(json: unknown): Set<string> {
  const list = obj(json).versions;
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((e) => obj(e).version)
      .filter(isVersion),
  );
}

export interface Release {
  version: string;
  /** ISO date (YYYY-MM-DD) of the release, if known. */
  date?: string;
  securityFixes?: number;
  critical?: number;
  high?: number;
  /** The Chrome Releases post, if one names this version. */
  url?: string;
}

/** Chromium Dash `fetch_releases`: Chrome's Stable releases for Linux. */
export function parseChromiumDash(json: unknown): Release[] {
  return (Array.isArray(json) ? json : []).flatMap((e) => {
    const r = obj(e);
    if (!isVersion(r.version)) return [];
    const t = typeof r.time === "number" ? new Date(r.time) : undefined;
    return [
      {
        version: r.version,
        ...(t && !isNaN(t.getTime())
          ? { date: t.toISOString().slice(0, 10) }
          : {}),
      },
    ];
  });
}

const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

/**
 * The Chrome Releases feed (Blogger JSON): Stable desktop updates only (not Early Stable,
 * Extended Stable or other platforms), each with its Linux version and security fix count.
 */
export function parseReleaseFeed(json: unknown): Release[] {
  const entries = obj(obj(json).feed).entry;
  return (Array.isArray(entries) ? entries : []).flatMap((e) => {
    const entry = obj(e);
    const labels = (Array.isArray(entry.category) ? entry.category : []).map(
      (c) => obj(c).term,
    );
    if (
      !labels.includes("Desktop Update") ||
      !labels.includes("Stable updates")
    )
      return [];
    const body = obj(entry.content).$t;
    if (typeof body !== "string") return [];
    const t = text(body);
    // "updated to 154.0.8037.97/.98 for Windows and Mac and 154.0.8037.97 to Linux": the last
    // full version before the word Linux.
    const at = t.search(/\bLinux\b/);
    const before = (at >= 0 ? t.slice(0, at) : t).match(/\d+\.\d+\.\d+\.\d+/g);
    const version = before?.at(-1);
    if (!isVersion(version)) return [];
    const fixes = /(\d+)\s+security fix/i.exec(t);
    const published = obj(entry.published).$t;
    const link = (Array.isArray(entry.link) ? entry.link : [])
      .map(obj)
      .find((l) => l.rel === "alternate")?.href;
    return [
      {
        version,
        securityFixes: fixes ? Number(fixes[1]) : 0,
        critical: (t.match(/\bCritical\s+CVE-/g) ?? []).length,
        high: (t.match(/\bHigh\s+CVE-/g) ?? []).length,
        ...(typeof published === "string" &&
        /^\d{4}-\d{2}-\d{2}/.test(published)
          ? { date: published.slice(0, 10) }
          : {}),
        ...(typeof link === "string" && BLOG.test(link) ? { url: link } : {}),
      },
    ];
  });
}

export interface Assessment {
  pinned: string;
  cftStable: string;
  /** Chrome's own Stable for Linux, if Chromium Dash or the blog could be read. */
  chromeStable?: string;
  /** The newest Stable either source knows. */
  newest: string;
  behind: boolean;
  milestonesBehind: number;
  /** Stable releases newer than the pin, oldest first. */
  releases: Release[];
  /** True if a release newer than the pin fixed security bugs (a new milestone always does); null if unknown. */
  crossesSecurityRelease: boolean | null;
  /** The first missed security release's date plus seven days. */
  deadline?: string;
  overdue: boolean;
  /** The newest version whose linux64 build Chrome for Testing serves, to update to. */
  updateTo?: string;
  listedByCft: Record<string, boolean>;
  downloadable: Record<string, boolean>;
  problems: string[];
}

export function assess(o: {
  pinned: string;
  cftStable: string;
  dash?: Release[] | undefined;
  posts?: Release[] | undefined;
  knownGood?: Set<string> | undefined;
  downloadable?: Record<string, boolean>;
  problems?: string[];
  now: Date;
}): Assessment {
  const byVersion = new Map<string, Release>();
  const add = (r: Release) =>
    byVersion.set(r.version, { ...byVersion.get(r.version), ...r });
  for (const r of o.dash ?? []) add(r);
  for (const r of o.posts ?? []) add(r); // the post's date and counts win
  if (!byVersion.has(o.cftStable)) add({ version: o.cftStable });

  const chromeStable = [...(o.dash ?? []), ...(o.posts ?? [])]
    .map((r) => r.version)
    .sort(compareVersions)
    .at(-1);
  const newest = [o.cftStable, chromeStable]
    .filter(isVersion)
    .sort(compareVersions)
    .at(-1)!;
  const releases = [...byVersion.values()]
    .filter((r) => compareVersions(r.version, o.pinned) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  const behind = compareVersions(o.pinned, newest) < 0;
  const milestonesBehind = Math.max(0, milestone(newest) - milestone(o.pinned));

  const security = releases.filter(
    (r) =>
      (r.securityFixes ?? 0) > 0 || milestone(r.version) > milestone(o.pinned),
  );
  const unknown = releases.some((r) => r.securityFixes === undefined);
  const crossesSecurityRelease = !behind
    ? false
    : security.length > 0
      ? true
      : unknown
        ? null
        : false;
  const firstDate = security.map((r) => r.date).find(Boolean);
  const deadline = firstDate
    ? new Date(Date.parse(firstDate) + PATCH_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : undefined;

  const listedByCft: Record<string, boolean> = {};
  if (o.knownGood)
    for (const r of releases)
      listedByCft[r.version] = o.knownGood.has(r.version);
  const downloadable = o.downloadable ?? {};
  const updateTo = [...releases]
    .reverse()
    .map((r) => r.version)
    .find(
      (v) => downloadable[v] === true || v === o.cftStable || listedByCft[v],
    );

  return {
    pinned: o.pinned,
    cftStable: o.cftStable,
    ...(chromeStable ? { chromeStable } : {}),
    newest,
    behind,
    milestonesBehind,
    releases,
    crossesSecurityRelease,
    ...(deadline ? { deadline } : {}),
    overdue:
      deadline !== undefined && o.now.toISOString().slice(0, 10) > deadline,
    ...(updateTo ? { updateTo } : {}),
    listedByCft,
    downloadable,
    problems: o.problems ?? [],
  };
}

/** A title for the tracking issue; stable while nothing changes, so updates do not churn it. */
export function issueTitle(a: Assessment): string {
  const sec =
    a.crossesSecurityRelease === true
      ? " (security release)"
      : a.crossesSecurityRelease === null
        ? " (security unknown)"
        : "";
  return `Chrome ${a.pinned} is behind Stable ${a.newest}${sec}`;
}

export function renderMarkdown(a: Assessment): string {
  const l: string[] = [];
  l.push(
    `## Chrome: pinned ${a.pinned}, Stable ${a.newest}`,
    "",
    "| Source | Version |",
    "| --- | --- |",
    `| Pinned (\`runtime/CHROME_VERSION\`) | ${a.pinned} |`,
    `| Chrome for Testing, Stable (last known good) | ${a.cftStable} |`,
    `| Chrome Stable for Linux (Chromium Dash, Chrome Releases) | ${a.chromeStable ?? "unknown"} |`,
    "",
  );
  if (!a.behind) {
    l.push("**Up to date.** The pin is Chrome's newest Stable.");
  } else {
    const n = a.releases.length;
    l.push(
      `**Behind by ${n} Stable release${n === 1 ? "" : "s"}` +
        (a.milestonesBehind
          ? ` and ${a.milestonesBehind} milestone${a.milestonesBehind === 1 ? "" : "s"}.**`
          : ` within milestone ${milestone(a.pinned)}.**`),
      "",
    );
    l.push(
      a.crossesSecurityRelease === true
        ? `**The gap crosses a security release.** HLD 8.5: rebuild and roll out within ${PATCH_DAYS} days` +
            (a.deadline
              ? `, by **${a.deadline}**${a.overdue ? " (overdue)" : ""}.`
              : ".")
        : a.crossesSecurityRelease === null
          ? "Whether the gap crosses a security release is unknown (the release notes could not be read); treat it as one."
          : "No security fixes in the gap.",
    );
    l.push(
      "",
      a.updateTo
        ? `Update to **${a.updateTo}**` +
            (a.updateTo === a.cftStable || a.listedByCft[a.updateTo]
              ? " (listed by Chrome for Testing)."
              : " (its linux64 build is downloadable from Chrome for Testing, though not yet in its known-good list).")
        : "No newer version is downloadable from Chrome for Testing yet; check again in a day or two.",
      "",
      "| Release | Date | Security fixes | Critical | High | On Chrome for Testing |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const r of a.releases) {
      const cft =
        r.version === a.cftStable || a.listedByCft[r.version]
          ? "listed"
          : a.downloadable[r.version]
            ? "downloadable"
            : a.downloadable[r.version] === false
              ? "no"
              : "not checked";
      l.push(
        `| ${r.url ? `[${r.version}](${r.url})` : r.version} | ${r.date ?? "?"} | ${r.securityFixes ?? "?"} | ${r.critical ?? "?"} | ${r.high ?? "?"} | ${cft} |`,
      );
    }
    l.push(
      "",
      'Procedure: `docs/runtime.md`, "Updating Chrome" (bump `runtime/CHROME_VERSION`, `runtime/build.sh`, rebuild the microVM template, re-run the checks).',
    );
  }
  if (a.problems.length)
    l.push(
      "",
      "Sources that could not be read:",
      ...a.problems.map((p) => `- ${p}`),
    );
  return l.join("\n") + "\n";
}

// --- the command --------------------------------------------------------------------------

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > 20 * 1024 * 1024) throw new Error(`${url}: too large`);
  return JSON.parse(body) as unknown;
}

async function exists(url: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const versionFile =
    arg(argv, "--version-file") ?? join(root, "runtime", "CHROME_VERSION");
  const pinned = readFileSync(versionFile, "utf8").trim();
  if (!isVersion(pinned)) {
    console.error(`${versionFile}: "${pinned}" is not a Chrome version`);
    return 1;
  }
  let cftStable: string;
  try {
    cftStable = parseCftStable(await getJson(SOURCES.cftLastKnownGood));
  } catch (e) {
    console.error(`Chrome for Testing could not be read: ${String(e)}`);
    return 1;
  }
  const problems: string[] = [];
  const optional = async <T>(name: string, f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  const [knownGood, dash, posts] = await Promise.all([
    optional("Chrome for Testing known-good versions", async () =>
      parseCftKnownGood(await getJson(SOURCES.cftKnownGood)),
    ),
    optional("Chromium Dash", async () =>
      parseChromiumDash(await getJson(SOURCES.chromiumDash)),
    ),
    optional("Chrome Releases feed", async () =>
      parseReleaseFeed(await getJson(SOURCES.releaseFeed)),
    ),
  ]);
  const first = assess({
    pinned,
    cftStable,
    dash,
    posts,
    knownGood,
    now: new Date(),
  });
  // Is a release newer than Chrome for Testing's listing already downloadable from it?
  const downloadable: Record<string, boolean> = {};
  for (const r of first.releases.slice(-3)) {
    if (r.version === cftStable || knownGood?.has(r.version)) continue;
    const ok = await optional(`download check for ${r.version}`, () =>
      exists(SOURCES.cftDownload(r.version)),
    );
    if (ok !== undefined) downloadable[r.version] = ok;
  }
  const a = assess({
    pinned,
    cftStable,
    dash,
    posts,
    knownGood,
    downloadable,
    problems,
    now: new Date(),
  });
  const md = renderMarkdown(a);
  process.stdout.write(md);
  const mdFile = arg(argv, "--markdown");
  if (mdFile) writeFileSync(mdFile, md);
  const jsonFile = arg(argv, "--json");
  if (jsonFile)
    writeFileSync(
      jsonFile,
      JSON.stringify({ ...a, title: issueTitle(a) }, null, 2) + "\n",
    );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(await main(process.argv.slice(2)));
