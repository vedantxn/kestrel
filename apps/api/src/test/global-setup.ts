import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bring the test database to the current schema, once per test run. */
export default function setup(): void {
  const url =
    process.env.DATABASE_URL ??
    "postgresql://kestrel:kestrel@localhost:5432/kestrel_test";
  if (!/_test(\b|$|\?)/.test(url)) {
    throw new Error(
      `refusing to run tests against a database that is not named *_test: ${url}`,
    );
  }
  const dbPackage = resolve(
    fileURLToPath(import.meta.url),
    "../../../../../packages/db",
  );
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: dbPackage,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
