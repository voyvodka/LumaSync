/**
 * vitest.config.ts — Vitest configuration for unit tests
 *
 * Scope: Unit tests only (no Tauri runtime, no browser APIs).
 * Tests mock Tauri plugin dependencies to run fast and deterministically.
 *
 * Run: yarn vitest run
 * Watch: yarn vitest
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use node environment for unit tests (no DOM required for policy/logic tests)
    // Switch to "jsdom" when React component rendering tests are added (requires: yarn add -D jsdom)
    environment: "node",

    // Global test APIs (describe, it, expect, vi) — no imports needed in test files
    globals: true,

    // Include only unit test files; exclude Tauri-specific integration tests
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],

    // Exclude node_modules and build artifacts
    exclude: ["node_modules/**", "dist/**", "src-tauri/**"],

    // Timeout per test (ms) — keep fast, deterministic
    testTimeout: 10000,
  },
});
