/**
 * vitest.config.ts — Vitest configuration for unit tests
 *
 * Scope: Unit tests only (no Tauri runtime, no browser APIs).
 * Tests mock Tauri plugin dependencies to run fast and deterministically.
 *
 * Run: bun run test
 * Watch: bunx vitest
 */

import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],

    // Global test APIs (describe, it, expect, vi) — no imports needed in test files
    globals: true,

    // Include only unit test files; exclude Tauri-specific integration tests.
    // `mock/` is dev-only and never ships, but its fixtures are bound to the
    // real contract types and its frame generator sizes itself from live state
    // — both are things that break silently, which is exactly what a test is
    // for. `verify:mock-not-shipped` guards the shipping question separately.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "mock/**/*.test.ts"],

    // Exclude node_modules and build artifacts
    exclude: ["node_modules/**", "dist/**", "src-tauri/**"],

    // Timeout per test (ms) — keep fast, deterministic
    testTimeout: 10000,

    // Appended to the defaults, which already vary (CI adds `github-actions`).
    // A `--reporter` flag replaces the list and drops the ratchet with it.
    reporters: [...configDefaults.reporters, "./scripts/verify/act-warning-ratchet.mjs"],
  },
});
