import { describe, expect, it } from "vitest";
import {
  assess,
  compareVersions,
  issueTitle,
  parseCftKnownGood,
  parseCftStable,
  parseChromiumDash,
  parseReleaseFeed,
  renderMarkdown,
} from "./chrome-check.js";

const post = (o: {
  version: string;
  date: string;
  fixes?: number;
  labels?: string[];
  body?: string;
}) => ({
  title: { $t: "Stable Channel Update for Desktop" },
  published: { $t: `${o.date}T18:04:35.613-07:00` },
  category: (o.labels ?? ["Desktop Update", "Stable updates"]).map((term) => ({
    term,
  })),
  link: [
    {
      rel: "alternate",
      href: `https://chromereleases.googleblog.com/${o.date.slice(0, 7).replace("-", "/")}/stable-channel-update-for-desktop.html`,
    },
  ],
  content: {
    $t:
      o.body ??
      `<span>The Stable channel has been updated to ${o.version}/.98 for Windows and Mac and ${o.version} to Linux which will roll out over the coming days/weeks.</span>` +
        (o.fixes
          ? `<span>This update includes ${o.fixes} security fixes.</span> [N/A][1] Critical CVE-2026-1: Out of bounds write in WebGL. [N/A][2] High CVE-2026-2: Use after free.`
          : ""),
  },
});

describe("Chrome release tracking (G-15)", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("154.0.8037.92", "154.0.8037.97")).toBe(-1);
    expect(compareVersions("154.0.8037.100", "154.0.8037.97")).toBe(1);
    expect(compareVersions("155.0.1.0", "154.9.9999.9")).toBe(1);
    expect(compareVersions("1.2.3.4", "1.2.3.4")).toBe(0);
  });

  it("reads Chrome for Testing's Stable version and listing, refusing anything that is not a version", () => {
    expect(
      parseCftStable({
        channels: { Stable: { channel: "Stable", version: "154.0.8037.92" } },
      }),
    ).toBe("154.0.8037.92");
    expect(() =>
      parseCftStable({ channels: { Stable: { version: "<b>1</b>" } } }),
    ).toThrow();
    expect(() => parseCftStable("nonsense")).toThrow();
    expect([
      ...parseCftKnownGood({
        versions: [{ version: "1.2.3.4" }, { version: "x" }, null],
      }),
    ]).toEqual(["1.2.3.4"]);
  });

  it("reads Chromium Dash releases with their dates", () => {
    expect(
      parseChromiumDash([
        { version: "154.0.8037.97", time: Date.UTC(2026, 9, 1, 12) },
        { version: "bad" },
      ]),
    ).toEqual([{ version: "154.0.8037.97", date: "2026-10-01" }]);
  });

  it("reads Stable desktop posts only, with the Linux version and security counts", () => {
    const feed = {
      feed: {
        entry: [
          post({ version: "154.0.8037.97", date: "2026-10-01", fixes: 11 }),
          post({
            version: "150.0.1.1",
            date: "2026-10-02",
            fixes: 3,
            labels: ["Desktop Update", "Extended Stable updates"],
          }),
          post({
            version: "154.0.8037.57",
            date: "2026-09-22",
            body: "The Stable channel has been updated to 154.0.8037.57 for Windows, Mac and Linux.",
          }),
          {
            ...post({ version: "1.1.1.1", date: "2026-09-01", fixes: 1 }),
            link: [{ rel: "alternate", href: "https://evil.example/x" }],
          },
        ],
      },
    };
    expect(parseReleaseFeed(feed)).toEqual([
      {
        version: "154.0.8037.97",
        date: "2026-10-01",
        securityFixes: 11,
        critical: 1,
        high: 1,
        url: "https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop.html",
      },
      {
        version: "154.0.8037.57",
        date: "2026-09-22",
        securityFixes: 0,
        critical: 0,
        high: 0,
        url: "https://chromereleases.googleblog.com/2026/09/stable-channel-update-for-desktop.html",
      },
      {
        version: "1.1.1.1",
        date: "2026-09-01",
        securityFixes: 1,
        critical: 1,
        high: 1,
        // a link off the blog's own domain is dropped
      },
    ]);
  });

  it("is up to date when the pin is the newest Stable", () => {
    const a = assess({
      pinned: "154.0.8037.97",
      cftStable: "154.0.8037.92",
      dash: [{ version: "154.0.8037.97", date: "2026-10-01" }],
      now: new Date("2026-10-06"),
    });
    expect(a.behind).toBe(false);
    expect(a.crossesSecurityRelease).toBe(false);
    expect(renderMarkdown(a)).toContain("Up to date");
  });

  it("finds a security release Chrome for Testing has not listed yet, with its deadline", () => {
    const a = assess({
      pinned: "154.0.8037.92",
      cftStable: "154.0.8037.92",
      dash: [
        { version: "154.0.8037.97", date: "2026-10-01" },
        { version: "154.0.8037.92", date: "2026-09-29" },
      ],
      posts: [
        {
          version: "154.0.8037.97",
          date: "2026-10-01",
          securityFixes: 11,
          critical: 1,
          high: 9,
        },
      ],
      knownGood: new Set(["154.0.8037.92"]),
      downloadable: { "154.0.8037.97": true },
      now: new Date("2026-10-09T00:00:00Z"),
    });
    expect(a.behind).toBe(true);
    expect(a.newest).toBe("154.0.8037.97");
    expect(a.releases.map((r) => r.version)).toEqual(["154.0.8037.97"]);
    expect(a.crossesSecurityRelease).toBe(true);
    expect(a.deadline).toBe("2026-10-08");
    expect(a.overdue).toBe(true);
    expect(a.updateTo).toBe("154.0.8037.97");
    expect(issueTitle(a)).toBe(
      "Chrome 154.0.8037.92 is behind Stable 154.0.8037.97 (security release)",
    );
    const md = renderMarkdown(a);
    expect(md).toContain("crosses a security release");
    expect(md).toContain("2026-10-08** (overdue)");
    expect(md).toContain("downloadable");
  });

  it("counts a new milestone as a security release, and says when it cannot tell", () => {
    const newMilestone = assess({
      pinned: "153.0.8010.52",
      cftStable: "154.0.8037.92",
      now: new Date("2026-10-06"),
    });
    expect(newMilestone.milestonesBehind).toBe(1);
    expect(newMilestone.crossesSecurityRelease).toBe(true);
    expect(newMilestone.updateTo).toBe("154.0.8037.92");

    const unknown = assess({
      pinned: "154.0.8037.57",
      cftStable: "154.0.8037.92",
      problems: ["Chrome Releases feed: HTTP 503"],
      now: new Date("2026-10-06"),
    });
    expect(unknown.crossesSecurityRelease).toBeNull();
    expect(renderMarkdown(unknown)).toContain("HTTP 503");
  });

  it("does not offer a version Chrome for Testing cannot serve", () => {
    const a = assess({
      pinned: "154.0.8037.92",
      cftStable: "154.0.8037.92",
      dash: [{ version: "154.0.8037.97", date: "2026-10-01" }],
      downloadable: { "154.0.8037.97": false },
      now: new Date("2026-10-02"),
    });
    expect(a.behind).toBe(true);
    expect(a.updateTo).toBeUndefined();
    expect(renderMarkdown(a)).toContain("No newer version is downloadable");
  });
});
