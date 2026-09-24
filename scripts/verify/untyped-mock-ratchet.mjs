#!/usr/bin/env node
/**
 * Ratchet on untyped test doubles: every bare `vi.fn()` in src/, mock/ and e2e/.
 *
 * A bare `vi.fn()` is `Mock<Procedure>` — assignable to any function, so a
 * double on the Tauri boundary can resolve a shape the backend never sends
 * and the test still passes. `vi.fn<typeof api.fn>()`, or `mockCommands({...})`
 * from `src/test/mockCommands.ts` (typed by the IPC command map), fails the
 * typecheck instead. Typing the boundary ones surfaced a validate code no producer
 * has ever emitted, runtime results missing fields Rust always sends, and a
 * twin-overlay reply of `{ ok: true }`.
 *
 * The count is static, so it is exact: above the baseline fails, and below it
 * fails too until the baseline is lowered — it may only shrink.
 *
 *   node scripts/verify/untyped-mock-ratchet.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const BASELINE_FILE = join(here, "untyped-mock-baseline.txt");
const PATTERN = /\bvi\.fn\(\)/g;

// A comment naming `vi.fn()` is not a double.
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const baselineLine = readFileSync(BASELINE_FILE, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith("#"));
const baseline = Number(baselineLine);
if (!Number.isInteger(baseline) || baseline < 0) {
  console.error(`${relative(ROOT, BASELINE_FILE)} must hold one non-negative integer, got ${JSON.stringify(baselineLine)}`);
  process.exit(1);
}

const byFile = [];
let count = 0;
for (const dir of ["src", "mock", "e2e"]) {
  for (const file of walk(join(ROOT, dir))) {
    const hits = (stripComments(readFileSync(file, "utf8")).match(PATTERN) ?? []).length;
    if (hits > 0) {
      count += hits;
      byFile.push([relative(ROOT, file), hits]);
    }
  }
}

console.log(`\n[ Untyped vi.fn() test doubles — ratcheted ]\n`);
if (count > baseline) {
  console.log(`  ✘  ${count} untyped vi.fn() (baseline ${baseline}) — the count may only shrink.`);
  console.log(`     Type the new double: vi.fn<typeof api.fn>(), or mockCommands({...}) on the command boundary.`);
  for (const [file, hits] of byFile.sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`       ${hits}  ${file}`);
  }
  process.exit(1);
}
if (count < baseline) {
  console.log(`  ✘  ${count} untyped vi.fn(), below the baseline of ${baseline}.`);
  console.log(`     Lower scripts/verify/untyped-mock-baseline.txt to ${count} so the gain is kept.`);
  process.exit(1);
}
console.log(`  ✔  ${count} untyped vi.fn() — at the baseline.`);
