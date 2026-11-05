import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          // Each case applies every migration to an isolated PostgreSQL schema.
          // Run after unit tests and bound concurrent DDL against the shared test DB.
          sequence: { groupOrder: 1 },
          maxWorkers: 2,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
