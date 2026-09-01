import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Only direct children of tests/ (NOT tests/integration/**) — that
    // folder talks to a REAL Supabase project (staging only — never
    // production, red rule #10) and needs SUPABASE_URL +
    // SUPABASE_SERVICE_ROLE_KEY set to that project. Left out of the glob so
    // the default `npm test` run stays fast, offline, and never touches a
    // real database by accident; run it explicitly, e.g.:
    //   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NODE_ENV=production \
    //     npx vitest run tests/integration/phase1-staging.test.ts
    include: ["tests/*.test.ts"],
    // Tests share the on-disk `data/` store (each deletes it in freshStore()),
    // so run files sequentially to avoid cross-file write races.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // The real `server-only` package throws unless resolved through
      // webpack's `react-server` condition (Next's server build only) — see
      // tests/stubs/server-only.ts.
      "server-only": path.resolve(dirname, "tests/stubs/server-only.ts"),
      "@": dirname,
    },
  },
});
