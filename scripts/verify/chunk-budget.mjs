#!/usr/bin/env node
/**
 * Per-chunk-class size gate for the frontend bundle.
 *
 * Vite's `chunkSizeWarningLimit` is one number for every chunk and only warns,
 * and nothing fails on a warning — so it had quietly stopped holding (the entry
 * passed 300 kB with every build printing the warning). This builds the
 * frontend into a temporary directory and fails when a chunk outgrows the budget
 * of its class:
 *
 *   entry — the HTML entries plus their static imports: what every window
 *           (main, popup, one twin overlay per display, scene) parses at start.
 *   lazy  — any other chunk, unless it has its own line in NAMED.
 *
 * Raising a budget is a decision, not a fix: say why in
 * docs/architecture/build-and-release.md in the same change.
 *
 *   node scripts/verify/chunk-budget.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { loadEnv } from "vite";

const ROOT = new URL("../..", import.meta.url).pathname;

/** kB as Vite reports them (1000 bytes). One file for the budgets, which `vite.config.ts` reads
 *  too, so Vite's own warning cannot drift from the gate. Lazy chunks with a budget of their own
 *  are matched on the chunk's name before its hash; each is explained in build-and-release.md, and
 *  a `spikeOnly` one must be absent from a build without its flag. */
const BUDGETS = JSON.parse(readFileSync(join(ROOT, "scripts/verify/chunk-budgets.json"), "utf-8"));
const ENTRY_BUDGET_KB = BUDGETS.entryKb;
const LAZY_BUDGET_KB = BUDGETS.lazyKb;
const NAMED = BUDGETS.named;
// The flag as the build sees it: Vite also reads it from `.env` files, so `process.env` alone
// called a spike chunk built from `.env.local` a leak.
const BUILD_ENV = { ...loadEnv("production", ROOT, ""), ...process.env };

let failures = 0;
const pass = (msg) => console.log(`  ✔  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘  ${msg}`);
};
const kb = (bytes) => (bytes / 1000).toFixed(1);

console.log("\n[ Chunk budget ]\n");

const outDir = mkdtempSync(join(tmpdir(), "lumasync-chunk-budget-"));
try {
  const build = spawnSync(
    join(ROOT, "node_modules/.bin/vite"),
    ["build", "--outDir", outDir, "--emptyOutDir", "--manifest", "--logLevel", "error"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (build.status !== 0) {
    fail(`vite build exited with ${build.status} — no sizes to check`);
  } else {
    const manifest = JSON.parse(readFileSync(join(outDir, ".vite/manifest.json"), "utf-8"));
    const size = (file) => statSync(join(outDir, file)).size;
    const isJs = (file) => file.endsWith(".js");

    const entryKeys = new Set();
    const visit = (key) => {
      if (entryKeys.has(key)) return;
      entryKeys.add(key);
      for (const dep of manifest[key].imports ?? []) visit(dep);
    };
    for (const [key, chunk] of Object.entries(manifest)) {
      if (chunk.isEntry) visit(key);
    }

    const entryFiles = [...entryKeys].map((key) => manifest[key].file).filter(isJs);
    const entryBytes = entryFiles.reduce((sum, file) => sum + size(file), 0);
    const entryLine = `entry ${kb(entryBytes)} kB of ${ENTRY_BUDGET_KB} kB (${entryFiles.map((f) => basename(f)).join(", ")})`;
    if (entryBytes > ENTRY_BUDGET_KB * 1000) fail(entryLine);
    else pass(entryLine);

    const lazy = Object.entries(manifest)
      .filter(([key, chunk]) => !entryKeys.has(key) && isJs(chunk.file))
      .map(([, chunk]) => chunk.file);
    let largest = { file: "", bytes: 0, budget: LAZY_BUDGET_KB };
    for (const file of new Set(lazy)) {
      const bytes = size(file);
      const name = basename(file).replace(/-[\w-]{8}\.js$/, "");
      const named = NAMED[name];
      if (named?.spikeOnly && BUILD_ENV[named.spikeOnly] !== "1") {
        fail(`lazy ${basename(file)} is built without ${named.spikeOnly}=1 — it would ship`);
      }
      const budget = named?.budget ?? LAZY_BUDGET_KB;
      if (bytes > budget * 1000) fail(`lazy ${basename(file)} ${kb(bytes)} kB over its ${budget} kB budget`);
      if (bytes > largest.bytes) largest = { file, bytes, budget };
    }
    pass(`largest lazy chunk ${basename(largest.file)} ${kb(largest.bytes)} kB (budget ${largest.budget} kB)`);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log("\n============================================");
if (failures > 0) {
  console.log(`✘  ${failures} chunk check(s) failed.`);
  process.exit(1);
}
console.log("✔  Chunks within budget.");
