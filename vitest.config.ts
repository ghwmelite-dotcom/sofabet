import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Model fitting + walk-forward backtests are CPU-heavy.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
