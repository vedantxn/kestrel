import { defineConfig } from "vitest/config";

// The root config also runs these tests, but brings up the API's test database first;
// this one lets the SDK's tests run alone without a database (`npm test -w @kestrel/sdk`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
