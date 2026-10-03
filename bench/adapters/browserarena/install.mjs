#!/usr/bin/env node
// Add Kestrel to a checkout of Browser Arena (github.com/nottelabs/browserarena).
//   node bench/adapters/browserarena/install.mjs <dir>     clones the pinned commit if <dir> is absent
// Idempotent: running it twice changes nothing. The diff it leaves is the upstream PR.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "c900b9d"; // the commit this adapter was written and tested against
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error("usage: install.mjs <browserarena dir>");
if (!existsSync(dir)) {
  execFileSync(
    "git",
    ["clone", "-q", "https://github.com/nottelabs/browserarena", dir],
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
const once = (s, marker, fn) => (s.includes(marker) ? s : fn(s));
const must = (s, anchor) => {
  if (!s.includes(anchor))
    throw new Error(`upstream changed: anchor not found: ${anchor}`);
  return s;
};

copyFileSync(join(here, "kestrel.ts"), join(dir, "src/providers/kestrel.ts"));

edit("src/types.ts", (s) =>
  once(s, '"KESTREL"', (t) =>
    t.replace(/(export type ProviderName =[^;]*);/, '$1\n  | "KESTREL";'),
  ),
);
edit("src/providers/index.ts", (s) =>
  once(s, "KestrelProvider", (t) => {
    t = must(t, 'import { LightpandaProvider } from "./lightpanda.js";');
    t = must(
      t,
      "  throw new Error(`Unknown provider: ${name}`);\n}\n\nexport function getMissingEnvVarsForProvider",
    );
    t = t.replace(
      'import { LightpandaProvider } from "./lightpanda.js";',
      'import { LightpandaProvider } from "./lightpanda.js";\nimport { KestrelProvider } from "./kestrel.js";',
    );
    t = t.replace(
      "  throw new Error(`Unknown provider: ${name}`);\n}\n\nexport function getMissingEnvVarsForProvider",
      '  if (key === "kestrel") return ["KESTREL_URL", "KESTREL_API_KEY"];\n  throw new Error(`Unknown provider: ${name}`);\n}\n\nexport function getMissingEnvVarsForProvider',
    );
    // The second "Unknown provider" throw is resolveProvider's.
    const i = t.lastIndexOf("  throw new Error(`Unknown provider: ${name}`);");
    return (
      t.slice(0, i) +
      '  if (key === "kestrel") return new KestrelProvider();\n' +
      t.slice(i)
    );
  }),
);
if (existsSync(join(dir, ".env.example")))
  edit(".env.example", (s) =>
    once(
      s,
      "KESTREL_API_KEY",
      (t) =>
        `${t.trimEnd()}\n\n# Kestrel (self-hosted) — your deployment's URL and a project API key.\nKESTREL_URL=\nKESTREL_API_KEY=\n`,
    ),
  );
console.log(
  `Kestrel added to ${dir}. Run: cd ${dir} && npm install && npm run bench -- --provider=kestrel --runs=10`,
);
