#!/usr/bin/env node
/**
 * Proves the dev mock cannot reach a shipped bundle.
 *
 * The guarantee is structural rather than a matter of tree-shaking: `index.html`
 * references only `/src/main.tsx`, no file under `src/` names `mock/`, and both
 * mock Vite plugins are registered only when `LUMASYNC_MOCK=1`. The production
 * module graph therefore has no edge to follow. This script asserts that the
 * structure still holds, and — the part that matters — proves the build guard by
 * running into it rather than grepping for it. A regex over `vite.config.ts`
 * would pass against a guard someone had softened into a warning.
 *
 *   node scripts/verify/mock-not-shipped.mjs            # (a) + (b), in check:all
 *   node scripts/verify/mock-not-shipped.mjs --dist     # (c), CI after a real build
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const CHECK_DIST = process.argv.includes("--dist");

let failures = 0;
const pass = (msg) => console.log(`  ✔  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘  ${msg}`);
};

/** Read the sentinel out of its source rather than restating it here. */
function sentinel() {
  const src = readFileSync(join(ROOT, "mock/boot.ts"), "utf-8");
  const match = /MOCK_BUILD_SENTINEL\s*=\s*"([^"]+)"/.exec(src);
  if (match === null) {
    fail("mock/boot.ts no longer declares MOCK_BUILD_SENTINEL — this script cannot check anything without it");
    return null;
  }
  return match[1];
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

console.log("\n[ Dev mock — ship safety ]\n");

const marker = sentinel();

// (a) Nothing shippable may name the mock.
{
  const SHIPPABLE = ["src", "e2e"].map((d) => join(ROOT, d)).filter(existsSync);
  const files = SHIPPABLE.flatMap((d) => walk(d)).filter((f) =>
    [".ts", ".tsx", ".js", ".jsx", ".css", ".html"].includes(extname(f)),
  );
  files.push(join(ROOT, "index.html"));

  const named = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    if (/["'`][^"'`]*\/?mock\/(boot|dispatch|tauriCoreShim)/.test(src) || (marker !== null && src.includes(marker))) {
      named.push(file.replace(ROOT, ""));
    }
  }
  if (named.length === 0) {
    pass("no shippable source names the dev mock");
  } else {
    fail(`the dev mock is named by shippable source, which gives the production graph an edge to it: ${named.join(", ")}`);
  }

  // The three core exports that close over the real module-local `invoke` and so
  // bypass the shim. None is used today; a new use would half-mock silently.
  const BYPASSERS = ["addPluginListener", "checkPermissions", "requestPermissions"];
  const used = [];
  for (const file of files.filter((f) => f.startsWith(join(ROOT, "src")))) {
    const src = readFileSync(file, "utf-8");
    for (const name of BYPASSERS) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(src)) used.push(`${name} in ${file.replace(ROOT, "")}`);
    }
  }
  if (used.length === 0) {
    pass("no src/ use of the three core exports that bypass the mock shim");
  } else {
    fail(
      `these close over core.js's module-local invoke and so skip the shim, producing a mock that half-works with no error: ${used.join(", ")}. Route the call through a command instead, or extend mock/tauriCoreShim.ts to reimplement it.`,
    );
  }
}

// (a2) The Hue fault injector is reachable from the dev surface only. Its debug
// arm drops a live DTLS stream on purpose; a production call site would hand
// that to every user of a debug build. The two contracts declare it (hue.ts
// names it, ipc.ts types it) and tests may drive it; nothing else under src/.
{
  const DECLARED_IN = new Set(["src/shared/contracts/hue.ts", "src/shared/contracts/ipc.ts"]);
  const isTest = (rel) =>
    rel.includes("/__tests__/") || /\.test\.tsx?$/.test(rel) || rel.startsWith("src/test/");
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const referencing = walk(join(ROOT, "src"))
    .filter((f) => [".ts", ".tsx", ".js", ".jsx"].includes(extname(f)))
    .map((f) => ({ file: f, rel: f.replace(ROOT, "") }))
    .filter(({ rel }) => !DECLARED_IN.has(rel) && !isTest(rel))
    .filter(({ file }) => /\bsimulate_hue_fault\b|\bHUE_DEBUG_COMMANDS\b/.test(stripComments(readFileSync(file, "utf-8"))))
    .map(({ rel }) => rel);
  if (referencing.length === 0) {
    pass("no non-test src/ file references simulate_hue_fault outside its contract declarations");
  } else {
    fail(
      `simulate_hue_fault is dev-only (mock/ui/DevPanel.tsx), but these src/ files reference it: ${referencing.join(", ")}`,
    );
  }
}

// (b) Run into the build guard.
{
  const r = spawnSync("bunx", ["vite", "build"], {
    cwd: ROOT,
    env: { ...process.env, LUMASYNC_MOCK: "1" },
    encoding: "utf8",
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) {
    fail("LUMASYNC_MOCK=1 did not stop a production build — the guard in vite.config.ts is gone");
  } else if (!/must never be bundled/.test(output)) {
    fail(`the build failed, but not on the mock guard:\n${output.slice(-400)}`);
  } else {
    pass("LUMASYNC_MOCK=1 aborts a production build before anything is written");
  }
}

// (c) Inspect the shipped bytes. Opt-in, because it needs a real build first.
if (CHECK_DIST) {
  const dist = join(ROOT, "dist");
  if (!existsSync(dist)) {
    fail("--dist was requested but dist/ does not exist; a skipped check must not read as a pass");
  } else if (marker !== null) {
    const hits = walk(dist).filter((f) => readFileSync(f, "utf-8").includes(marker));
    if (hits.length === 0) {
      pass(`no dist/ file carries the sentinel (${walk(dist).length} files scanned)`);
    } else {
      fail(`the sentinel reached the bundle: ${hits.map((f) => f.replace(ROOT, "")).join(", ")}`);
    }
  }
}

console.log(`\n${"=".repeat(44)}`);
if (failures === 0) {
  console.log("✔  Dev mock cannot reach a shipped bundle.\n");
  process.exit(0);
}
console.log(`✘  ${failures} check(s) failed — the dev mock could ship.\n`);
process.exit(1);
