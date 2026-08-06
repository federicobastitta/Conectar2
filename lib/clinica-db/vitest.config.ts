import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Ejecuta tests en serie para no interferir entre schemas de test
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    conditions: ["import", "node"],
  },
});
