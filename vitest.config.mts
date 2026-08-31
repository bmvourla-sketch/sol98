import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
