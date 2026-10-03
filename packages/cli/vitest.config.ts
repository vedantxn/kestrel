import { defineConfig } from "vitest/config";

// The root config also runs these tests, but brings up the API's test database first;
// this one lets the CLI's tests run alone without a database (`npm test -w @kestrel/cli`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
