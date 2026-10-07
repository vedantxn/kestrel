import { describe, expect, it } from "vitest";
import { PROFILE_LIMITS } from "./profile.js";
import {
  ProfileArchiveError,
  ProfileArchiveParser,
  ProfileCookies,
  ProfileManifest,
  checkProfileManifest,
  encodeProfileArchive,
  encodeProfileArchiveHead,
  parseProfileArchive,
  profilePathProblem,
  type ProfileArchivePart,
  type ProfileCookie,
} from "./profile-archive.js";

const MAX = PROFILE_LIMITS.maxBytes;

const cookie = (over: Partial<ProfileCookie> = {}): ProfileCookie => ({
  name: "sid",
  value: "abc",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  expires: 1_900_000_000,
  ...over,
});

const files = [
  { path: "Default/LocalStorage", data: Buffer.from("local storage") },
  {
    path: "Default/IndexedDB/https_example.com_0.indexeddb.leveldb/000003.log",
    data: Buffer.from("idb"),
  },
  { path: "Default/WebStorage/QuotaManager-journal", data: Buffer.alloc(0) },
  {
    path: "Default/WebStorage/QuotaManager",
    data: Buffer.from("q".repeat(50)),
  },
];

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProfileArchiveError) return e.reason;
    throw e;
  }
  return "ok";
}

function manifest(paths: string[], bytes = 1): unknown {
  return {
    format: 1,
    cookies: { bytes: 0, count: 0 },
    files: paths.map((path) => ({ path, bytes })),
  };
}

describe("profile paths", () => {
  it("admits the allowlisted files and directories", () => {
    for (const p of [
      "Default/LocalStorage",
      "Default/LocalStorage-journal",
      "Default/LocalStorage-wal",
      "Default/Local Storage/leveldb/000005.ldb",
      "Default/Local Storage/leveldb/MANIFEST-000001",
      "Default/IndexedDB/http_127.0.0.1_59040/252AGOW5QBPAPYMMORGI7GOASCBVUWFVTOLUO4IXTMW4CGBZ6NCA",
      "Default/IndexedDB/https_a.example_0.indexeddb.blob/1/00/3",
      "Default/WebStorage/QuotaManager",
    ])
      expect(profilePathProblem(p), p).toBeNull();
  });

  it("refuses every path rule", () => {
    const cases: [string, string][] = [
      ["Default/IndexedDB/../Preferences", "dot segment"],
      ["Default/IndexedDB/./x", "dot segment"],
      ["/Default/LocalStorage", "empty segment"],
      ["Default//LocalStorage", "empty segment"],
      ["Default/IndexedDB/", "empty segment"],
      ["", "empty segment"],
      ["Default/IndexedDB/a\\b", "bad character"],
      ["Default/IndexedDB/a\u0000b", "bad character"],
      ["Default/IndexedDB/é", "bad character"],
      [`Default/IndexedDB/${"a".repeat(129)}`, "segment too long"],
      ["Default/IndexedDB/1/2/3/4/5/6/7", "path too deep"],
      [
        `Default/IndexedDB/${"a".repeat(120)}/${"b".repeat(120)}`,
        "path too long",
      ],
      ["Default/IndexedDB/x/LOCK", "denied name"],
      ["Default/Local Storage/leveldb/LOG", "denied name"],
      ["Default/Local Storage/leveldb/LOG.old", "denied name"],
      ["Default/Preferences", "not in the allowlist"],
      ["Local State", "not in the allowlist"],
      ["Default/Cookies", "not in the allowlist"],
      ["Default/Extensions/abc/manifest.json", "not in the allowlist"],
      ["Default/Service Worker/CacheStorage/x", "not in the allowlist"],
      ["Default/LocalStorageX", "not in the allowlist"],
      ["Default/LocalStorage/inner", "not in the allowlist"],
      ["Default/Local Storage/other", "not in the allowlist"],
      ["Default/IndexedDBX/a", "not in the allowlist"],
    ];
    for (const [p, why] of cases) expect(profilePathProblem(p), p).toBe(why);
    // 8 segments is the most, and 255 bytes
    expect(profilePathProblem("Default/IndexedDB/1/2/3/4/5/6")).toBeNull();
    const at255 = `Default/IndexedDB/${"a".repeat(118)}/${"b".repeat(255 - 18 - 119)}`;
    expect(Buffer.byteLength(at255)).toBe(255);
    expect(profilePathProblem(at255)).toBeNull();
  });
});

describe("the manifest", () => {
  it("is strict", () => {
    expect(reason(() => checkProfileManifest(manifest([]), MAX))).toBe("ok");
    expect(
      reason(() =>
        checkProfileManifest({ ...(manifest([]) as object), extra: 1 }, MAX),
      ),
    ).toBe("invalid_archive");
    expect(
      reason(() =>
        checkProfileManifest({ ...(manifest([]) as object), format: 2 }, MAX),
      ),
    ).toBe("invalid_archive");
    expect(
      reason(() =>
        checkProfileManifest(
          {
            format: 1,
            cookies: { bytes: 0, count: 0 },
            files: [{ path: "Default/LocalStorage", bytes: 1, mode: 0o777 }],
          },
          MAX,
        ),
      ),
    ).toBe("invalid_archive");
    expect(
      reason(() =>
        checkProfileManifest(manifest(["Default/Preferences"]), MAX),
      ),
    ).toBe("invalid_archive");
  });

  it("refuses duplicates and a file that is also a directory", () => {
    expect(
      reason(() =>
        checkProfileManifest(
          manifest(["Default/LocalStorage", "Default/LocalStorage"]),
          MAX,
        ),
      ),
    ).toBe("invalid_archive");
    expect(
      reason(() =>
        checkProfileManifest(
          manifest(["Default/IndexedDB/a", "Default/IndexedDB/a/b"]),
          MAX,
        ),
      ),
    ).toBe("invalid_archive");
  });

  it("counts and sizes at and past each cap", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `Default/IndexedDB/o/${i}`);
    expect(reason(() => checkProfileManifest(manifest(many(4096)), MAX))).toBe(
      "ok",
    );
    expect(reason(() => checkProfileManifest(manifest(many(4097)), MAX))).toBe(
      "too_large",
    );
    // the total against the caller's cap
    expect(reason(() => checkProfileManifest(manifest(many(4), 25), 100))).toBe(
      "ok",
    );
    expect(reason(() => checkProfileManifest(manifest(many(4), 25), 99))).toBe(
      "too_large",
    );
    // one file past the ceiling
    expect(
      reason(() =>
        checkProfileManifest(
          manifest(
            ["Default/LocalStorage"],
            PROFILE_LIMITS.maxBytesCeiling + 1,
          ),
          MAX,
        ),
      ),
    ).toBe("too_large");
    const c = (bytes: number, count: number) => ({
      format: 1,
      cookies: { bytes, count },
      files: [],
    });
    expect(
      reason(() =>
        checkProfileManifest(c(PROFILE_LIMITS.cookiesBytes, 5000), MAX),
      ),
    ).toBe("ok");
    expect(
      reason(() =>
        checkProfileManifest(c(PROFILE_LIMITS.cookiesBytes + 1, 1), MAX),
      ),
    ).toBe("too_large");
    expect(reason(() => checkProfileManifest(c(10, 5001), MAX))).toBe(
      "too_large",
    );
    expect(reason(() => checkProfileManifest(c(-1, 0), MAX))).toBe(
      "invalid_archive",
    );
  });
});

describe("cookies", () => {
  it("takes CDP cookie params with bounded strings, strictly", () => {
    expect(
      ProfileCookies.safeParse([
        cookie(),
        cookie({ expires: undefined, sameSite: undefined }),
        cookie({
          partitionKey: {
            topLevelSite: "https://example.com",
            hasCrossSiteAncestor: false,
          },
          sourceScheme: "Secure",
          sourcePort: 443,
          priority: "Medium",
        }),
        cookie({ value: "a\tb" }),
      ]).success,
    ).toBe(true);
    for (const bad of [
      { ...cookie(), url: "https://example.com" },
      cookie({ name: "x".repeat(4097) }),
      cookie({ value: "x".repeat(4097) }),
      cookie({ domain: "d".repeat(254) }),
      cookie({ path: "/".repeat(1025) }),
      cookie({ value: "a\nb" }),
      cookie({ name: "a\u0000" }),
      cookie({ domain: "" }),
      cookie({ expires: Number.POSITIVE_INFINITY }),
      cookie({ sameSite: "none" as never }),
      {
        ...cookie(),
        partitionKey: {
          topLevelSite: "https://a",
          hasCrossSiteAncestor: false,
          extra: 1,
        },
      },
    ])
      expect(
        ProfileCookies.safeParse([bad]).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    expect(
      ProfileCookies.safeParse(Array.from({ length: 5001 }, () => cookie()))
        .success,
    ).toBe(false);
  });
});

describe("the archive", () => {
  const cookies = [cookie(), cookie({ name: "other", httpOnly: false })];
  const body = encodeProfileArchive(cookies, files);

  it("round-trips", () => {
    const got = parseProfileArchive(body, MAX);
    expect(got.cookies).toEqual(cookies);
    expect(got.files.map((f) => [f.path, f.data.toString()])).toEqual(
      files.map((f) => [f.path, f.data.toString()]),
    );
    expect(ProfileManifest.parse(got.manifest).files).toHaveLength(4);
  });

  it("parses the same at every chunking", () => {
    const expected = JSON.stringify(collect([body]));
    for (let size = 1; size <= 64; size++) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < body.length; i += size)
        chunks.push(body.subarray(i, i + size));
      expect(JSON.stringify(collect(chunks)), `chunk ${size}`).toBe(expected);
    }
    // and split at every single offset into two
    for (let i = 0; i <= body.length; i++)
      expect(
        JSON.stringify(collect([body.subarray(0, i), body.subarray(i)])),
      ).toBe(expected);
  });

  it("never passes on a file's bytes before the manifest and cookies checked", () => {
    const p = new ProfileArchiveParser(MAX);
    const parts = p.push(body);
    expect(parts.map((x) => x.kind).slice(0, 3)).toEqual([
      "manifest",
      "cookies",
      "file",
    ]);
  });

  it("refuses a short body and a long one", () => {
    for (const cut of [1, 3, 4, 10, body.length - 1]) {
      expect(
        reason(() => parseProfileArchive(body.subarray(0, cut), MAX)),
      ).toBe("invalid_archive");
    }
    expect(
      reason(() =>
        parseProfileArchive(Buffer.concat([body, Buffer.from([0])]), MAX),
      ),
    ).toBe("invalid_archive");
    const p = new ProfileArchiveParser(MAX);
    p.push(body);
    expect(reason(() => p.push(Buffer.from("x")))).toBe("invalid_archive");
  });

  it("refuses a manifest length past 1 MiB, or zero, before reading it", () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(PROFILE_LIMITS.manifestBytes + 1);
    expect(reason(() => new ProfileArchiveParser(MAX).push(len))).toBe(
      "too_large",
    );
    expect(
      reason(() => new ProfileArchiveParser(MAX).push(Buffer.alloc(4))),
    ).toBe("invalid_archive");
  });

  it("refuses a manifest that is not JSON, and cookies that do not match it", () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(3);
    expect(
      reason(() =>
        parseProfileArchive(Buffer.concat([len, Buffer.from("{{{")]), MAX),
      ),
    ).toBe("invalid_archive");
    // the count in the manifest says 3, the cookies hold 2
    const cookiesJson = Buffer.from(JSON.stringify(cookies));
    const head = encodeProfileArchiveHead({
      format: 1,
      cookies: { bytes: cookiesJson.length, count: 3 },
      files: [],
    });
    expect(
      reason(() =>
        parseProfileArchive(Buffer.concat([head, cookiesJson]), MAX),
      ),
    ).toBe("invalid_archive");
    const notCookies = Buffer.from(JSON.stringify([{ name: "x" }]));
    const head2 = encodeProfileArchiveHead({
      format: 1,
      cookies: { bytes: notCookies.length, count: 1 },
      files: [],
    });
    expect(
      reason(() =>
        parseProfileArchive(Buffer.concat([head2, notCookies]), MAX),
      ),
    ).toBe("invalid_archive");
  });

  it("refuses an archive with a hostile path anywhere", () => {
    const json = Buffer.from(
      JSON.stringify(manifest(["Default/IndexedDB/../../etc/passwd"])),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    expect(
      reason(() =>
        parseProfileArchive(Buffer.concat([len, json, Buffer.from("x")]), MAX),
      ),
    ).toBe("invalid_archive");
  });

  it("refuses a body past the caller's cap from its manifest alone", () => {
    const big = encodeProfileArchiveHead({
      format: 1,
      cookies: { bytes: 0, count: 0 },
      files: [{ path: "Default/LocalStorage", bytes: 1000 }],
    });
    expect(reason(() => new ProfileArchiveParser(999).push(big))).toBe(
      "too_large",
    );
  });
});

function collect(chunks: Buffer[]) {
  const p = new ProfileArchiveParser(MAX);
  const parts: ProfileArchivePart[] = [];
  for (const c of chunks) parts.push(...p.push(c));
  p.finish();
  // merge data parts so the result does not depend on the chunking
  const files: Record<number, string> = {};
  const out: unknown[] = [];
  for (const part of parts) {
    if (part.kind === "data")
      files[part.index] = (files[part.index] ?? "") + part.data.toString("hex");
    else out.push(part);
  }
  return { out, files };
}
