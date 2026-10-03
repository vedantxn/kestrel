#!/usr/bin/env node
// Add Kestrel to a checkout of the ComputeSDK benchmarks (github.com/computesdk/benchmarks):
// the browser lifecycle and browser throughput benchmarks.
//   node bench/adapters/computesdk/install.mjs <dir>     clones the pinned commit if <dir> is absent
// Idempotent: running it twice changes nothing. The diff it leaves is the upstream PR.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "24922f2"; // the commit this adapter was written and tested against
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error("usage: install.mjs <benchmarks dir>");
if (!existsSync(dir)) {
  execFileSync(
    "git",
    ["clone", "-q", "https://github.com/computesdk/benchmarks", dir],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", dir, "checkout", "-q", PIN], { stdio: "inherit" });
}
const edit = (rel, fn) => {
  const p = join(dir, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after !== before) writeFileSync(p, after);
};
const IMPORT = "import { kestrel } from './kestrel-provider.js';";
const ENTRY = (extra) => `  {
    name: 'kestrel',
    requiredEnvVars: ['KESTREL_API_KEY', 'KESTREL_URL'],
    createBrowserProvider: () => kestrel({
      apiKey: process.env.KESTREL_API_KEY!,
      baseUrl: process.env.KESTREL_URL!,
    }),
    sessionCreateOptions: { ${extra} },
  },
`;
/** Insert the import after the last import line, and the entry just before the array's closing `];`. */
const register = (extra) => (s) => {
  if (s.includes("name: 'kestrel'")) return s;
  const lines = s.split("\n");
  const lastImport = lines
    .map((l) => l.startsWith("import "))
    .lastIndexOf(true);
  if (lastImport < 0) throw new Error("upstream changed: no imports found");
  lines.splice(lastImport + 1, 0, IMPORT);
  s = lines.join("\n");
  const marker = s.includes("  // add browser providers above")
    ? "  // add browser providers above"
    : "\n];";
  const at = s.lastIndexOf(marker);
  if (at < 0) throw new Error("upstream changed: provider list end not found");
  const insertAt = marker === "\n];" ? at + 1 : at;
  return s.slice(0, insertAt) + ENTRY(extra) + s.slice(insertAt);
};

copyFileSync(
  join(here, "kestrel-provider.ts"),
  join(dir, "benchmarks/browser/kestrel-provider.ts"),
);
edit("benchmarks/browser/providers.ts", register(""));
// Kestrel's page is at most 1920x1000 (the display also holds Chrome's toolbar); the adapter clamps.
edit(
  "benchmarks/browser/throughput-providers.ts",
  register("viewport: VIEWPORT"),
);
edit("package.json", (s) => {
  const pkg = JSON.parse(s);
  if (pkg.scripts["bench:browser:kestrel"]) return s;
  pkg.scripts["bench:browser:kestrel"] =
    "tsx packages/benchsdk-runner/dist/bin.js run benchmarks/browser/browser.bench.ts --provider kestrel";
  return JSON.stringify(pkg, null, 2) + "\n";
});
console.log(
  `Kestrel added to ${dir}. Run: cd ${dir} && npm install && npm run bench:browser:kestrel`,
);
