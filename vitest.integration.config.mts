// Separate config for tests/integration/** — the Phase 1 tests that need a
// REAL Supabase project (staging only, red rule #10). Kept out of the
// default vitest.config.mts include glob so `npm test` never touches a live
// database; run explicitly:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NODE_ENV=production \
//     npx vitest run --config vitest.integration.config.mts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(dirname, "tests/stubs/server-only.ts"),
      "@": dirname,
    },
  },
});
