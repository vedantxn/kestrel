import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Check {
  id: string;
  name: string;
  pass: boolean;
  /** What was measured against what was required. */
  detail: string;
}

export interface Report {
  name: string;
  startedAt: string;
  finishedAt: string;
  /** Hardware, session size, pool size, and what was deployed: published results state their conditions. */
  environment: Record<string, string | number>;
  checks: Check[];
  /** Recorded numbers that do not gate (H7). */
  measurements: Record<string, unknown>;
  pass: boolean;
}

export function makeReport(
  name: string,
  environment: Report["environment"],
  startedAt = new Date(),
): {
  add(c: Check): void;
  measure(k: string, v: unknown): void;
  build(): Report;
} {
  const checks: Check[] = [];
  const measurements: Record<string, unknown> = {};
  return {
    add: (c) => void checks.push(c),
    measure: (k, v) => void (measurements[k] = v),
    build: () => ({
      name,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment,
      checks,
      measurements,
      pass: checks.length > 0 && checks.every((c) => c.pass),
    }),
  };
}

const fmt = (v: unknown): string =>
  typeof v === "number"
    ? Number.isInteger(v)
      ? String(v)
      : v.toFixed(1)
    : JSON.stringify(v);

/** Markdown for a person to read. */
export function renderMarkdown(r: Report): string {
  const lines = [
    `# ${r.name}`,
    "",
    `**${r.pass ? "PASS" : "FAIL"}** · ${r.startedAt} to ${r.finishedAt}`,
    "",
    "## Environment",
    "",
    ...Object.entries(r.environment).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Checks",
    "",
    "| # | Check | Result | Detail |",
    "|---|---|---|---|",
    ...r.checks.map(
      (c) =>
        `| ${c.id} | ${c.name} | ${c.pass ? "pass" : "**FAIL**"} | ${c.detail.replaceAll("|", "\\|")} |`,
    ),
    "",
    "## Measurements (not gating)",
    "",
    ...Object.entries(r.measurements).map(([k, v]) => `- ${k}: ${fmt(v)}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * H6. JSON plus Markdown on disk, one line of JSON on stdout, a non-zero exit on failure, so a
 * script (or a CI step, or an agent) can act on the result without parsing prose.
 */
export function finish(
  r: Report,
  dir: string,
  stdout: (s: string) => void = (s) => console.log(s),
): number {
  const base = `${dir}/${r.name.replace(/[^a-z0-9._-]+/gi, "-")}-${r.startedAt.replace(/[:.]/g, "-")}`;
  mkdirSync(dirname(`${base}.json`), { recursive: true });
  writeFileSync(`${base}.json`, `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderMarkdown(r));
  stdout(
    JSON.stringify({
      name: r.name,
      pass: r.pass,
      failed: r.checks.filter((c) => !c.pass).map((c) => c.id),
      report: `${base}.json`,
    }),
  );
  return r.pass ? 0 : 1;
}
