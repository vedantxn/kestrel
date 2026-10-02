import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    globalSetup: ["apps/api/src/test/global-setup.ts"],
    // The API tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://kestrel:kestrel@localhost:5432/kestrel_test",
    },
  },
});
